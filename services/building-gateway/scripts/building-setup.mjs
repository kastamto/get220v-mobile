#!/usr/bin/env node
/**
 * Helper setup data "building" di ThingsBoard (memakai kredensial tenant dari .env).
 * Semua perintah yang menulis ke TB default DRY-RUN; tambahkan --apply untuk benar-benar menulis.
 *
 *   npm run setup -- list
 *   npm run setup -- create --name "Rukita Amani" [--label "Amani, Jaksel"] [--apply]
 *   npm run setup -- link --building <id|nama> --match "Amani|AMN" [--apply]
 *   npm run setup -- link --building <id|nama> --devices <uuid,uuid> [--space <assetId>] [--apply]
 *   npm run setup -- dashboards --building <id|nama> --set <dashUuid,dashUuid> [--apply]
 *   npm run setup -- show --building <id|nama>
 *
 * Bulk (semua device sekaligus lewat CSV/Excel):
 *   npm run setup -- export [--out devices.csv]     # semua device + building sekarang + saran
 *   npm run setup -- bulk --file devices.csv [--apply]
 *   npm run setup -- undo --file bulk-undo-<waktu>.json [--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../src/config.js';
import { TbClient } from '../src/tbClient.js';
import { parseCsv, toCsv, planBulk } from '../src/bulk.js';

loadDotEnv();
const env = process.env;
const TYPE = env.BUILDING_ASSET_TYPE || 'building';
const REL = env.BUILDING_RELATION_TYPE || 'Contains';
const SPACE_TYPE = env.SPACE_ASSET_TYPE || 'space';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    args[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
}
const APPLY = Boolean(args.apply);

if (!env.TB_TENANT_USERNAME || !env.TB_TENANT_PASSWORD) {
  console.error('Set TB_TENANT_USERNAME / TB_TENANT_PASSWORD di .env dulu');
  process.exit(1);
}
const tb = new TbClient({
  baseUrl: (env.TB_INTERNAL_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  username: env.TB_TENANT_USERNAME,
  password: env.TB_TENANT_PASSWORD,
});

async function pageAll(path) {
  const out = [];
  for (let page = 0; page < 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await tb.asTenant('GET', `${path}${sep}pageSize=100&page=${page}`);
    out.push(...r.data);
    if (!r.hasNext) break;
  }
  return out;
}

async function buildings() {
  return pageAll(`/api/tenant/assets?type=${encodeURIComponent(TYPE)}`);
}

async function resolveBuilding(ref) {
  if (!ref) throw new Error('--building wajib');
  const all = await buildings();
  const b = UUID.test(ref) ? all.find((a) => a.id.id === ref.toLowerCase()) : all.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
  const one = Array.isArray(b) ? (b.length === 1 ? b[0] : null) : b;
  if (!one) throw new Error(`building "${ref}" tidak ditemukan / ambigu (cek: npm run setup -- list)`);
  return one;
}

async function relations(bid) {
  return tb.asTenant('POST', '/api/relations/info', {
    parameters: { rootId: bid, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 5, fetchLastLevelOnly: false },
    filters: [{ relationType: REL, entityTypes: ['ASSET', 'DEVICE'] }],
  });
}

// Asset space dibuat dengan nama "<Building> - <Space>" (nama asset TB unik per tenant); bandingkan tanpa prefix.
const spaceName = (buildingName, assetName) => (assetName?.startsWith(`${buildingName} - `) ? assetName.slice(buildingName.length + 3) : assetName);

/** Kondisi tenant sekarang: device, building, space, dan parent (relasi Contains yang dikelola) tiap device. */
async function tenantState() {
  const devices = (await pageAll('/api/tenant/deviceInfos')).map((d) => ({
    id: d.id.id,
    name: d.name,
    label: d.label ?? '',
    type: d.type,
    customer: d.customerIsPublic ? '' : d.customerTitle ?? '',
  }));
  const blds = (await buildings()).map((b) => ({ id: b.id.id, name: b.name }));
  const spaces = [];
  const parents = new Map();
  for (const b of blds) {
    for (const r of await relations(b.id)) {
      if (r.to.entityType === 'ASSET') spaces.push({ id: r.to.id, name: spaceName(b.name, r.toName), buildingId: b.id, parentId: r.from.id });
      else if (r.to.entityType === 'DEVICE') {
        if (!parents.has(r.to.id)) parents.set(r.to.id, []);
        if (!parents.get(r.to.id).some((p) => p.fromId === r.from.id)) parents.get(r.to.id).push({ fromId: r.from.id, buildingId: b.id });
      }
    }
  }
  return { devices, buildings: blds, spaces, parents };
}

const relationBody = (fromId, toId, toType) => ({ from: { id: fromId, entityType: 'ASSET' }, to: { id: toId, entityType: toType }, type: REL, typeGroup: 'COMMON' });
const deleteRelationPath = (fromId, toId, toType) =>
  `/api/relation?${new URLSearchParams({ fromId, fromType: 'ASSET', relationType: REL, relationTypeGroup: 'COMMON', toId, toType })}`;

const dry = () => console.log(APPLY ? '' : '\n(DRY-RUN — tambahkan --apply untuk menulis ke TB)');

const commands = {
  async list() {
    const all = await buildings();
    if (!all.length) console.log(`Belum ada asset type "${TYPE}". Buat dengan: npm run setup -- create --name "..." --apply`);
    for (const b of all) {
      const rels = await relations(b.id.id);
      const n = rels.filter((r) => r.to.entityType === 'DEVICE').length;
      console.log(`${b.id.id}  ${b.name.padEnd(32)} ${String(n).padStart(4)} device`);
    }
    const devs = await pageAll('/api/tenant/deviceInfos');
    console.log(`\nTotal device di tenant: ${devs.length}`);
  },

  async create() {
    if (!args.name) throw new Error('--name wajib');
    const exists = (await buildings()).find((a) => a.name.toLowerCase() === args.name.toLowerCase());
    if (exists) return console.log(`Sudah ada: ${exists.id.id} ${exists.name}`);
    const body = { name: args.name, type: TYPE, label: typeof args.label === 'string' ? args.label : undefined };
    console.log('Akan membuat asset:', body);
    if (APPLY) {
      const a = await tb.asTenant('POST', '/api/asset', body);
      console.log(`Dibuat: ${a.id.id}`);
    }
    dry();
  },

  async link() {
    const b = await resolveBuilding(args.building);
    const from = UUID.test(args.space ?? '') ? { id: args.space.toLowerCase(), entityType: 'ASSET' } : { id: b.id.id, entityType: 'ASSET' };
    const existing = new Set((await relations(b.id.id)).filter((r) => r.to.entityType === 'DEVICE').map((r) => r.to.id));
    const devs = await pageAll('/api/tenant/deviceInfos');
    let picked;
    if (typeof args.devices === 'string') {
      const want = new Set(args.devices.split(',').map((s) => s.trim().toLowerCase()));
      picked = devs.filter((d) => want.has(d.id.id));
    } else if (typeof args.match === 'string') {
      const re = new RegExp(args.match, 'i');
      picked = devs.filter((d) => re.test(d.name) || re.test(d.label ?? ''));
    } else throw new Error('pakai --match <regex> atau --devices <uuid,...>');

    const todo = picked.filter((d) => !existing.has(d.id.id));
    console.log(`Building: ${b.name} (${b.id.id})${from.id !== b.id.id ? `, space ${from.id}` : ''}`);
    console.log(`Cocok ${picked.length} device, ${picked.length - todo.length} sudah ter-link, ${todo.length} akan di-link:`);
    for (const d of todo) console.log(`  + ${d.id.id}  ${d.name}${d.label ? ` (${d.label})` : ''}  [${d.type}]`);
    if (APPLY) {
      for (const d of todo) {
        await tb.asTenant('POST', '/api/relation', { from, to: { id: d.id.id, entityType: 'DEVICE' }, type: REL, typeGroup: 'COMMON' });
      }
      console.log(`Selesai: ${todo.length} relasi "${REL}" dibuat.`);
    }
    dry();
  },

  async dashboards() {
    const b = await resolveBuilding(args.building);
    if (typeof args.set !== 'string') throw new Error('--set <dashUuid,...> wajib');
    const ids = args.set.split(',').map((s) => s.trim().toLowerCase());
    const list = [];
    for (const id of ids) {
      if (!UUID.test(id)) throw new Error(`${id} bukan UUID`);
      const info = await tb.asTenant('GET', `/api/dashboard/info/${id}`);
      list.push({ id, title: info.title });
    }
    console.log(`Building ${b.name}: dashboards =`, list);
    if (APPLY) {
      await tb.asTenant('POST', `/api/plugins/telemetry/ASSET/${b.id.id}/attributes/SERVER_SCOPE`, { dashboards: list });
      console.log('Tersimpan di server attribute "dashboards".');
    }
    dry();
  },

  async export() {
    const st = await tenantState();
    const bName = new Map(st.buildings.map((b) => [b.id, b.name]));
    const sName = new Map(st.spaces.map((x) => [x.id, x.name]));
    const rows = st.devices
      .map((d) => {
        const p = st.parents.get(d.id)?.[0];
        return {
          id: d.id,
          name: d.name,
          label: d.label,
          type: d.type,
          customer: d.customer,
          building: p ? bName.get(p.buildingId) : '',
          space: p && p.fromId !== p.buildingId ? sName.get(p.fromId) ?? '' : '',
          suggested_building: p ? '' : d.customer,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const out = typeof args.out === 'string' ? args.out : 'devices.csv';
    writeFileSync(out, toCsv(rows, ['id', 'name', 'label', 'type', 'customer', 'building', 'space', 'suggested_building']));
    const linked = rows.filter((r) => r.building).length;
    console.log(`${rows.length} device ditulis ke ${out} (${linked} sudah punya building, ${rows.length - linked} belum).`);
    console.log('Isi kolom "building" (dan "space" opsional, mis. "Lantai 2"), lalu: npm run setup -- bulk --file ' + out);
  },

  async bulk() {
    if (typeof args.file !== 'string') throw new Error('--file <csv> wajib');
    const rows = parseCsv(readFileSync(args.file, 'utf8'));
    const st = await tenantState();
    const plan = planBulk({ rows, devices: st.devices, buildings: st.buildings, spaces: st.spaces, parents: st.parents });

    console.log(`Rencana dari ${args.file} (${rows.length} baris):`);
    for (const b of plan.createBuildings) console.log(`  + building baru   : ${b.name}`);
    for (const x of plan.createSpaces) console.log(`  + space baru      : ${x.buildingName} / ${x.name}`);
    for (const l of plan.link) console.log(`  → link           : ${l.deviceName}  ⇒  ${l.building}${l.space ? ` / ${l.space}` : ''}`);
    for (const u of plan.unlink) console.log(`  ✕ lepas relasi lama: ${u.deviceName}  (dari ${u.fromId})`);
    console.log(`  = tidak berubah   : ${plan.unchanged.length} device, dilewati (building kosong): ${plan.skipped.length}`);
    for (const e of plan.errors) console.log(`  ! ${e}`);
    if (plan.errors.length) {
      console.log('\nPerbaiki error di CSV dulu; tidak ada yang ditulis.');
      process.exitCode = 1;
      return;
    }
    if (!APPLY) return dry();

    const journal = { createdAt: new Date().toISOString(), file: args.file, actions: [] };
    const journalFile = `bulk-undo-${journal.createdAt.replace(/[:.]/g, '-')}.json`;
    const save = () => writeFileSync(journalFile, JSON.stringify(journal, null, 2));
    const ids = new Map(); // key rencana -> asset id
    try {
      for (const b of plan.createBuildings) {
        const a = await tb.asTenant('POST', '/api/asset', { name: b.name, type: TYPE });
        ids.set(b.key, a.id.id);
        journal.actions.push({ op: 'createAsset', id: a.id.id, name: b.name });
        save();
      }
      const resolve = (k) => ids.get(k) ?? k;
      for (const x of plan.createSpaces) {
        const a = await tb.asTenant('POST', '/api/asset', { name: `${x.buildingName} - ${x.name}`, label: x.name, type: SPACE_TYPE });
        ids.set(x.key, a.id.id);
        journal.actions.push({ op: 'createAsset', id: a.id.id, name: a.name });
        await tb.asTenant('POST', '/api/relation', relationBody(resolve(x.buildingKey), a.id.id, 'ASSET'));
        journal.actions.push({ op: 'createRelation', fromId: resolve(x.buildingKey), toId: a.id.id, toType: 'ASSET' });
        save();
      }
      for (const u of plan.unlink) {
        await tb.asTenant('DELETE', deleteRelationPath(u.fromId, u.deviceId, 'DEVICE'));
        journal.actions.push({ op: 'deleteRelation', fromId: u.fromId, toId: u.deviceId, toType: 'DEVICE' });
        save();
      }
      for (const l of plan.link) {
        await tb.asTenant('POST', '/api/relation', relationBody(resolve(l.targetKey), l.deviceId, 'DEVICE'));
        journal.actions.push({ op: 'createRelation', fromId: resolve(l.targetKey), toId: l.deviceId, toType: 'DEVICE' });
        save();
      }
      // flag di device: memudahkan filter / alias dashboard / FMEA tanpa query relasi
      for (const l of [...plan.link, ...plan.unchanged]) {
        await tb.asTenant('POST', `/api/plugins/telemetry/DEVICE/${l.deviceId}/attributes/SERVER_SCOPE`, {
          building: l.building,
          buildingId: resolve(l.buildingKey),
          space: l.space ?? '',
        });
      }
      journal.actions.push({ op: 'flags', deviceIds: [...plan.link, ...plan.unchanged].map((l) => l.deviceId) });
      save();
    } catch (e) {
      save();
      console.error(`\nGAGAL di tengah jalan: ${e.message}`);
      console.error(`Yang sudah dikerjakan tercatat di ${journalFile}; batalkan dengan: npm run setup -- undo --file ${journalFile} --apply`);
      process.exit(1);
    }
    console.log(`\nSelesai. Catatan undo: ${journalFile}`);
  },

  async undo() {
    if (typeof args.file !== 'string') throw new Error('--file bulk-undo-*.json wajib');
    const journal = JSON.parse(readFileSync(args.file, 'utf8'));
    const steps = [...journal.actions].reverse();
    for (const a of steps) {
      if (a.op === 'flags') console.log(`  hapus flag building/buildingId/space di ${a.deviceIds.length} device`);
      if (a.op === 'createRelation') console.log(`  hapus relasi ${a.fromId} → ${a.toId}`);
      if (a.op === 'deleteRelation') console.log(`  pulihkan relasi ${a.fromId} → ${a.toId}`);
      if (a.op === 'createAsset') console.log(`  hapus asset ${a.name} (${a.id})`);
    }
    if (!APPLY) return dry();
    for (const a of steps) {
      if (a.op === 'flags') {
        for (const id of a.deviceIds) await tb.asTenant('DELETE', `/api/plugins/telemetry/DEVICE/${id}/SERVER_SCOPE?keys=building,buildingId,space`);
      } else if (a.op === 'createRelation') await tb.asTenant('DELETE', deleteRelationPath(a.fromId, a.toId, a.toType)).catch(() => {});
      else if (a.op === 'deleteRelation') await tb.asTenant('POST', '/api/relation', relationBody(a.fromId, a.toId, a.toType));
      else if (a.op === 'createAsset') await tb.asTenant('DELETE', `/api/asset/${a.id}`).catch(() => {});
    }
    console.log('Undo selesai.');
  },

  async show() {
    const b = await resolveBuilding(args.building);
    const rels = await relations(b.id.id);
    console.log(`${b.name} (${b.id.id})`);
    const children = new Map();
    for (const r of rels) {
      if (!children.has(r.from.id)) children.set(r.from.id, []);
      children.get(r.from.id).push(r);
    }
    const walk = (id, depth, seen = new Set()) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const r of children.get(id) ?? []) {
        console.log(`${'  '.repeat(depth)}${r.to.entityType === 'DEVICE' ? '•' : '▸'} ${r.toName} (${r.to.id})`);
        if (r.to.entityType === 'ASSET') walk(r.to.id, depth + 1, seen);
      }
    };
    walk(b.id.id, 1);
  },
};

if (!commands[cmd]) {
  console.log('Perintah: list | create | link | dashboards | show | export | bulk | undo   (lihat komentar di atas file)');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
