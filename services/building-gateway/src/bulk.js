/**
 * Bulk assign device -> building (/space) dari CSV. Logika murni (tanpa I/O) supaya bisa dites;
 * I/O ke TB ada di scripts/building-setup.mjs.
 *
 * CSV kolom: id, name, building, space   (id ATAU name wajib; building kosong = baris dilewati)
 */

/** Parser CSV kecil (koma atau titik koma, tanda kutip ganda, header di baris pertama). */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r, i) => {
    const o = { _line: i + 2 };
    header.forEach((h, j) => (o[h] = (r[j] ?? '').trim()));
    return o;
  });
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @param rows       baris CSV
 * @param devices    [{id, name}]
 * @param buildings  [{id, name}]                 asset type building yang sudah ada
 * @param spaces     [{id, name, buildingId}]     asset di bawah building (lantai/ruang)
 * @param parents    Map deviceId -> [{fromId, buildingId}]  relasi Contains yang dikelola (dari building/space)
 */
export function planBulk({ rows, devices, buildings, spaces, parents }) {
  const byId = new Map(devices.map((d) => [d.id.toLowerCase(), d]));
  const byName = new Map();
  for (const d of devices) {
    const k = norm(d.name);
    byName.set(k, byName.has(k) ? null : d); // null = nama ganda
  }
  const bByName = new Map(buildings.map((b) => [norm(b.name), b]));
  const sByKey = new Map(spaces.map((s) => [`${s.buildingId}|${norm(s.name)}`, s]));

  const plan = { createBuildings: [], createSpaces: [], link: [], unlink: [], unchanged: [], skipped: [], errors: [] };
  const newBuildings = new Set();
  const newSpaces = new Set();
  const seenDevices = new Map();

  for (const r of rows) {
    const where = `baris ${r._line}`;
    let dev = null;
    if (r.id) {
      dev = byId.get(r.id.toLowerCase());
      if (!dev) {
        plan.errors.push(`${where}: device id ${r.id} tidak ditemukan`);
        continue;
      }
    } else if (r.name) {
      dev = byName.get(norm(r.name));
      if (dev === null) {
        plan.errors.push(`${where}: nama device "${r.name}" ganda, pakai kolom id`);
        continue;
      }
      if (!dev) {
        plan.errors.push(`${where}: device "${r.name}" tidak ditemukan`);
        continue;
      }
    } else {
      plan.errors.push(`${where}: kolom id atau name wajib`);
      continue;
    }
    if (!r.building) {
      plan.skipped.push({ deviceId: dev.id, deviceName: dev.name });
      continue;
    }
    if (seenDevices.has(dev.id)) {
      plan.errors.push(`${where}: device "${dev.name}" sudah muncul di baris ${seenDevices.get(dev.id)}`);
      continue;
    }
    seenDevices.set(dev.id, r._line);

    const b = bByName.get(norm(r.building));
    const bKey = b ? b.id : `new:${norm(r.building)}`;
    if (!b && !newBuildings.has(bKey)) {
      newBuildings.add(bKey);
      plan.createBuildings.push({ key: bKey, name: r.building });
    }
    let targetKey = bKey;
    if (r.space) {
      const existing = b && sByKey.get(`${b.id}|${norm(r.space)}`);
      if (existing) targetKey = existing.id;
      else {
        targetKey = `newspace:${bKey}|${norm(r.space)}`;
        if (!newSpaces.has(targetKey)) {
          newSpaces.add(targetKey);
          plan.createSpaces.push({ key: targetKey, name: r.space, buildingKey: bKey, buildingName: b?.name ?? r.building });
        }
      }
    }

    const current = parents.get(dev.id) ?? [];
    const item = { deviceId: dev.id, deviceName: dev.name, building: b?.name ?? r.building, buildingKey: bKey, space: r.space || null, targetKey };
    if (current.length === 1 && current[0].fromId === targetKey) {
      plan.unchanged.push(item);
      continue;
    }
    for (const p of current) if (p.fromId !== targetKey) plan.unlink.push({ deviceId: dev.id, deviceName: dev.name, fromId: p.fromId });
    if (!current.some((p) => p.fromId === targetKey)) plan.link.push(item);
    else plan.unchanged.push(item);
  }
  return plan;
}
