import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv, planBulk } from '../src/bulk.js';
import { startMockTb, ID } from './mockTb.js';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/building-setup.mjs');

test('parseCsv: header, kutip, koma di dalam kutip, titik koma (Excel ID), BOM, baris kosong', () => {
  assert.deepEqual(parseCsv('﻿id,Name,building\n1,"Pompa, A",Amani\n\n2,"Kata ""kutip""",\n'), [
    { _line: 2, id: '1', name: 'Pompa, A', building: 'Amani' },
    { _line: 3, id: '2', name: 'Kata "kutip"', building: '' },
  ]);
  assert.deepEqual(parseCsv('name;building;space\r\nGerbang;Amani;Lantai 1\r\n'), [{ _line: 2, name: 'Gerbang', building: 'Amani', space: 'Lantai 1' }]);
  const round = parseCsv(toCsv([{ a: 'x,y', b: 'q"z' }], ['a', 'b']));
  assert.deepEqual(round, [{ _line: 2, a: 'x,y', b: 'q"z' }]);
});

test('planBulk: building/space baru, pindah gedung, tidak berubah, error', () => {
  const devices = [
    { id: 'd1', name: 'Pompa A' },
    { id: 'd2', name: 'Gerbang' },
    { id: 'd3', name: 'Meter' },
    { id: 'd4', name: 'Kembar' },
    { id: 'd5', name: 'kembar' },
  ];
  const buildings = [{ id: 'b1', name: 'Amani' }];
  const spaces = [{ id: 's1', name: 'Lantai 1', buildingId: 'b1' }];
  const parents = new Map([
    ['d1', [{ fromId: 's1', buildingId: 'b1' }]],
    ['d2', [{ fromId: 'b1', buildingId: 'b1' }]],
  ]);
  const rows = parseCsv(
    'id,name,building,space\n' +
      'd1,,amani,lantai 1\n' + // sama persis (beda huruf besar) -> tidak berubah
      ',Gerbang,Nismara,\n' + // pindah ke building baru
      'd3,,Nismara,Rooftop\n' + // building baru + space baru
      ',Kembar,Amani,\n' + // nama ganda
      ',Hantu,Amani,\n' + // tidak ada
      'd3,,Amani,\n' + // duplikat
      ',Pompa A,,\n', // dilewati
  );
  const plan = planBulk({ rows, devices, buildings, spaces, parents });
  assert.deepEqual(plan.createBuildings.map((b) => b.name), ['Nismara']);
  assert.deepEqual(plan.createSpaces.map((s) => [s.buildingName, s.name]), [['Nismara', 'Rooftop']]);
  assert.deepEqual(plan.unchanged.map((u) => u.deviceId), ['d1']);
  assert.deepEqual(plan.link.map((l) => [l.deviceId, l.targetKey]), [
    ['d2', 'new:nismara'],
    ['d3', 'newspace:new:nismara|rooftop'],
  ]);
  assert.deepEqual(plan.unlink, [{ deviceId: 'd2', deviceName: 'Gerbang', fromId: 'b1' }]);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.errors.length, 3);
  assert.match(plan.errors.join('\n'), /ganda/);
  assert.match(plan.errors.join('\n'), /Hantu.*tidak ditemukan/);
  assert.match(plan.errors.join('\n'), /sudah muncul di baris 4/);
});

let tb, dir;
before(async () => {
  tb = await startMockTb();
  dir = mkdtempSync(join(tmpdir(), 'bulk-'));
});
after(() => {
  tb.server.close();
  tb.server.closeAllConnections();
});

function run(...argv) {
  return new Promise((res) => {
    execFile(process.execPath, [SCRIPT, ...argv], {
      cwd: dir,
      env: { ...process.env, TB_INTERNAL_URL: tb.url, TB_TENANT_USERNAME: 'tenant@x', TB_TENANT_PASSWORD: 'pw' },
    }, (err, stdout, stderr) => res({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}

const edgesOf = (to) => tb.state.edges.filter((e) => e.to === to).map((e) => e.from);

test('export -> edit -> bulk dry-run -> apply -> undo (ujung ke ujung dengan TB tiruan)', async () => {
  const ex = await run('export', '--out', 'devices.csv');
  assert.equal(ex.code, 0, ex.out);
  const rows = parseCsv(readFileSync(join(dir, 'devices.csv'), 'utf8'));
  assert.deepEqual(rows.map((r) => [r.name, r.building, r.space, r.suggested_building]), [
    ['Gerbang', 'Rukita Amani', '', ''],
    ['Meter Bintaro', 'Rukita Bintaro', '', ''],
    ['Pompa A', 'Rukita Amani', 'Lantai 1', ''],
  ]);

  // Kas mengedit CSV: Gerbang pindah ke gedung baru, Meter ke space baru di Amani
  writeFileSync(join(dir, 'edit.csv'), `id,name,building,space\n${ID.DEV2},Gerbang,Rukita Nismara,\n${ID.DEV3},,Rukita Amani,Rooftop\n${ID.DEV1},,Rukita Amani,Lantai 1\n`);
  const before = JSON.stringify(tb.state.edges);
  const dry = await run('bulk', '--file', 'edit.csv');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /building baru\s+: Rukita Nismara/);
  assert.match(dry.out, /DRY-RUN/);
  assert.equal(JSON.stringify(tb.state.edges), before, 'dry-run tidak boleh menulis');

  const ap = await run('bulk', '--file', 'edit.csv', '--apply');
  assert.equal(ap.code, 0, ap.out);
  const nismara = Object.values(tb.state.assets).find((a) => a.name === 'Rukita Nismara');
  const rooftop = Object.values(tb.state.assets).find((a) => a.label === 'Rooftop');
  assert.equal(nismara.type, 'building');
  assert.equal(rooftop.type, 'space');
  assert.deepEqual(edgesOf(ID.DEV2), [nismara.id.id]);
  assert.deepEqual(edgesOf(ID.DEV3), [rooftop.id.id]);
  assert.deepEqual(edgesOf(rooftop.id.id), [ID.B1]);
  assert.deepEqual(edgesOf(ID.DEV1), [ID.F1]);
  assert.deepEqual(tb.state.serverAttrs[ID.DEV3], { building: 'Rukita Amani', buildingId: ID.B1, space: 'Rooftop' });
  assert.deepEqual(tb.state.serverAttrs[ID.DEV1], { building: 'Rukita Amani', buildingId: ID.B1, space: 'Lantai 1' });

  // idempotent: apply ulang tidak membuat relasi ganda
  const again = await run('bulk', '--file', 'edit.csv');
  assert.match(again.out, /tidak berubah\s+: 3 device/);

  const journal = readdirSync(dir).find((f) => f.startsWith('bulk-undo-'));
  const un = await run('undo', '--file', journal, '--apply');
  assert.equal(un.code, 0, un.out);
  const key = (e) => `${e.from}>${e.to}`;
  assert.deepEqual(tb.state.edges.map(key).sort(), JSON.parse(before).map(key).sort(), 'relasi kembali seperti semula');
  assert.deepEqual(edgesOf(ID.DEV2).sort(), [ID.B1]);
  assert.deepEqual(edgesOf(ID.DEV3), [ID.B2]);
  assert.equal(Object.values(tb.state.assets).some((a) => a.name === 'Rukita Nismara'), false);
  assert.deepEqual(tb.state.serverAttrs[ID.DEV3], {});
});

test('bulk menolak CSV yang ada error, tanpa menulis apa pun', async () => {
  writeFileSync(join(dir, 'bad.csv'), 'name,building\nTidak Ada,Rukita Amani\n');
  const before = JSON.stringify(tb.state.edges);
  const r = await run('bulk', '--file', 'bad.csv', '--apply');
  assert.equal(r.code, 1);
  assert.match(r.out, /tidak ditemukan/);
  assert.equal(JSON.stringify(tb.state.edges), before);
});
