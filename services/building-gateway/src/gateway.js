/**
 * Logika domain "building": semua akses device/dashboard dibatasi ke satu gedung.
 *
 * Model di ThingsBoard (TB-native, tanpa database tambahan):
 *   Asset type "building"  --Contains-->  Asset (lantai/ruang, opsional, bertingkat)  --Contains-->  Device
 *   Server attribute "dashboards" pada asset building = daftar dashboard gedung itu.
 */
import { TbError } from './tbClient.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** TB REST mengembalikan nilai telemetry sebagai string; ubah ke tipe JSON yang wajar. */
export function toValue(v) {
  if (typeof v !== 'string') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (v.startsWith('{') || v.startsWith('[')) {
    try {
      return JSON.parse(v);
    } catch {
      /* biarkan string */
    }
  }
  return v;
}

/**
 * REST  : {key: [{ts, value}]}
 * WS    : {key: [[ts, value]]}
 * -> {key: {ts, value}} (data terbaru)
 */
export function normalizeLatest(raw) {
  const out = {};
  for (const [k, arr] of Object.entries(raw ?? {})) {
    const p = Array.isArray(arr) ? arr[0] : arr;
    if (Array.isArray(p)) out[k] = { ts: p[0], value: toValue(p[1]) };
    else if (p) out[k] = { ts: p.ts, value: toValue(p.value) };
  }
  return out;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const AGG = new Set(['NONE', 'AVG', 'MIN', 'MAX', 'SUM', 'COUNT']);
const ALARM_STATUS = new Set(['ACTIVE', 'CLEARED', 'ACK', 'UNACK']);
const KEY_RE = /^[\w.\-:]{1,128}$/;

export function parseKeys(s, { required = false, max = 50 } = {}) {
  if (!s) {
    if (required) throw new ApiError(400, 'keys wajib (pisahkan dengan koma)');
    return [];
  }
  const keys = [...new Set(String(s).split(',').map((k) => k.trim()).filter(Boolean))];
  if (keys.length > max) throw new ApiError(400, `maksimal ${max} keys`);
  for (const k of keys) if (!KEY_RE.test(k)) throw new ApiError(400, `key tidak valid: ${k}`);
  return keys;
}

export class Gateway {
  constructor({ tb, config, now = Date.now }) {
    this.tb = tb;
    this.config = config;
    this.now = now;
    this.topoCache = new Map(); // buildingId -> { value, exp }
    this.topoPending = new Map();
    this.buildingsCache = null;
  }

  // ---------- akses ----------

  canAccessBuilding(client, buildingId) {
    return client.buildings.all || client.buildings.ids.has(buildingId);
  }

  async #tenant(method, path, body) {
    try {
      return await this.tb.asTenant(method, path, body);
    } catch (e) {
      if (e instanceof TbError && e.status === 404) throw new ApiError(404, 'tidak ditemukan');
      throw e;
    }
  }

  // ---------- gedung ----------

  async allBuildings() {
    if (this.buildingsCache && this.buildingsCache.exp > this.now()) return this.buildingsCache.value;
    const out = [];
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ pageSize: '100', page: String(page), type: this.config.buildingAssetType, sortProperty: 'name', sortOrder: 'ASC' });
      const r = await this.#tenant('GET', `/api/tenant/assets?${qs}`);
      for (const a of r.data) out.push({ id: a.id.id, name: a.name, label: a.label ?? null, type: a.type });
      if (!r.hasNext) break;
    }
    this.buildingsCache = { value: out, exp: this.now() + this.config.cacheSec * 1000 };
    return out;
  }

  async listBuildings(client) {
    return (await this.allBuildings()).filter((b) => this.canAccessBuilding(client, b.id));
  }

  /** Pohon gedung: lantai/ruang (asset) & device, di-cache TOPOLOGY_CACHE_SEC. */
  async topology(buildingId) {
    const c = this.topoCache.get(buildingId);
    if (c && c.exp > this.now()) return c.value;
    if (!this.topoPending.has(buildingId)) {
      const p = this.#loadTopology(buildingId)
        .then((value) => {
          this.topoCache.set(buildingId, { value, exp: this.now() + this.config.cacheSec * 1000 });
          return value;
        })
        .finally(() => this.topoPending.delete(buildingId));
      this.topoPending.set(buildingId, p);
    }
    return this.topoPending.get(buildingId);
  }

  async #loadTopology(buildingId) {
    const asset = await this.#tenant('GET', `/api/asset/${buildingId}`);
    if (String(asset.type).toLowerCase() !== this.config.buildingAssetType.toLowerCase()) {
      throw new ApiError(404, 'building tidak ditemukan');
    }
    const rels = await this.#tenant('POST', '/api/relations/info', {
      parameters: {
        rootId: buildingId,
        rootType: 'ASSET',
        direction: 'FROM',
        relationTypeGroup: 'COMMON',
        maxLevel: this.config.maxLevel,
        fetchLastLevelOnly: false,
      },
      filters: [{ relationType: this.config.relationType, entityTypes: ['ASSET', 'DEVICE'] }],
    });
    const spaces = new Map();
    const devices = new Map();
    for (const r of rels ?? []) {
      // relasi "Contains" dari DEVICE (bukan ASSET) bukan bagian topologi building/space —
      // TB tetap menyusurinya karena filter entityTypes tidak membatasi hop rekursif, dan kalau
      // ikut dipakai, device lama di gedung lain yang punya relasi semacam ini bisa "bocor" ke
      // gedung ini. Abaikan.
      if (r.from.entityType !== 'ASSET') continue;
      const node = { id: r.to.id, name: r.toName ?? null, parentId: r.from.id };
      if (r.to.entityType === 'DEVICE' && !devices.has(node.id)) devices.set(node.id, node);
      else if (r.to.entityType === 'ASSET' && !spaces.has(node.id) && node.id !== buildingId) spaces.set(node.id, node);
    }
    const pathOf = (parentId) => {
      const names = [];
      const seen = new Set();
      let cur = parentId;
      while (cur && cur !== buildingId && spaces.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        names.unshift(spaces.get(cur).name);
        cur = spaces.get(cur).parentId;
      }
      return names;
    };
    // space dibuat helper bulk dengan nama "<Building> - <Space>"; tampilkan tanpa prefix
    const prefix = `${asset.name} - `;
    for (const sp of spaces.values()) if (sp.name?.startsWith(prefix)) sp.name = sp.name.slice(prefix.length);
    for (const d of devices.values()) d.path = pathOf(d.parentId);
    for (const s of spaces.values()) s.path = pathOf(s.parentId);
    return {
      building: { id: asset.id.id, name: asset.name, label: asset.label ?? null, type: asset.type },
      spaces,
      devices,
    };
  }

  async requireBuilding(client, buildingId) {
    if (!this.canAccessBuilding(client, buildingId)) throw new ApiError(403, 'building tidak diizinkan untuk client ini');
    return this.topology(buildingId);
  }

  async requireDevice(client, buildingId, deviceId) {
    const topo = await this.requireBuilding(client, buildingId);
    const d = topo.devices.get(deviceId);
    if (!d) throw new ApiError(404, 'device tidak ada di building ini');
    return { topo, device: d };
  }

  async buildingDetail(client, buildingId) {
    const topo = await this.requireBuilding(client, buildingId);
    const attrs = await this.#tenant('GET', `/api/plugins/telemetry/ASSET/${buildingId}/values/attributes/SERVER_SCOPE`);
    const attributes = {};
    for (const a of attrs ?? []) if (a.key !== 'dashboards') attributes[a.key] = toValue(a.value);
    return {
      ...topo.building,
      attributes,
      deviceCount: topo.devices.size,
      spaces: [...topo.spaces.values()].map((s) => ({ id: s.id, name: s.name, parentId: s.parentId, path: s.path })),
    };
  }

  // ---------- device ----------

  async listDevices(client, buildingId, { type, search } = {}) {
    const topo = await this.requireBuilding(client, buildingId);
    const ids = [...topo.devices.keys()];
    const rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await this.#tenant('POST', '/api/entitiesQuery/find', {
        entityFilter: { type: 'entityList', entityType: 'DEVICE', entityList: chunk },
        entityFields: ['name', 'label', 'type'].map((key) => ({ type: 'ENTITY_FIELD', key })),
        latestValues: ['active', 'lastActivityTime'].map((key) => ({ type: 'SERVER_ATTRIBUTE', key })),
        pageLink: { page: 0, pageSize: chunk.length },
      });
      for (const e of r.data ?? []) {
        const f = e.latest?.ENTITY_FIELD ?? {};
        const s = e.latest?.SERVER_ATTRIBUTE ?? {};
        const node = topo.devices.get(e.entityId.id);
        rows.push({
          id: e.entityId.id,
          name: f.name?.value ?? node?.name ?? null,
          label: f.label?.value || null,
          type: f.type?.value ?? null,
          active: s.active?.value === undefined || s.active.value === '' ? null : toValue(s.active.value),
          lastActivityTime: s.lastActivityTime?.value ? Number(s.lastActivityTime.value) : null,
          spaceId: node?.parentId !== buildingId ? node?.parentId ?? null : null,
          path: node?.path ?? [],
        });
      }
    }
    let out = rows;
    if (type) out = out.filter((d) => d.type === type);
    if (search) {
      const q = String(search).toLowerCase();
      out = out.filter((d) => `${d.name} ${d.label ?? ''}`.toLowerCase().includes(q));
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async deviceDetail(client, buildingId, deviceId) {
    const { device } = await this.requireDevice(client, buildingId, deviceId);
    const [info, keys, latest] = await Promise.all([
      this.#tenant('GET', `/api/device/${deviceId}`),
      this.#tenant('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/keys/timeseries`),
      this.#tenant('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`),
    ]);
    return {
      id: deviceId,
      name: info.name,
      label: info.label ?? null,
      type: info.type,
      path: device.path,
      telemetryKeys: keys ?? [],
      latest: normalizeLatest(latest),
    };
  }

  async latest(client, buildingId, deviceId, keys) {
    await this.requireDevice(client, buildingId, deviceId);
    const qs = keys.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
    return normalizeLatest(await this.#tenant('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries${qs}`));
  }

  async buildingLatest(client, buildingId, keys) {
    const topo = await this.requireBuilding(client, buildingId);
    const qs = keys.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
    const devs = [...topo.devices.values()];
    const values = await mapLimit(devs, 8, async (d) => {
      try {
        return normalizeLatest(await this.#tenant('GET', `/api/plugins/telemetry/DEVICE/${d.id}/values/timeseries${qs}`));
      } catch {
        return null; // satu device gagal tidak menggagalkan snapshot gedung
      }
    });
    return devs.map((d, i) => ({ id: d.id, name: d.name, path: d.path, latest: values[i], error: values[i] === null ? 'unavailable' : undefined }));
  }

  async history(client, buildingId, deviceId, q) {
    await this.requireDevice(client, buildingId, deviceId);
    const keys = parseKeys(q.keys, { required: true, max: 20 });
    const endTs = q.endTs ? Number(q.endTs) : this.now();
    const startTs = q.startTs ? Number(q.startTs) : endTs - 24 * 3600_000;
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || startTs >= endTs) throw new ApiError(400, 'startTs/endTs tidak valid (epoch ms)');
    if (endTs - startTs > 92 * 86400_000) throw new ApiError(400, 'rentang maksimal 92 hari');
    const agg = (q.agg ?? 'NONE').toUpperCase();
    if (!AGG.has(agg)) throw new ApiError(400, `agg harus salah satu: ${[...AGG].join(', ')}`);
    const limit = Math.min(Number(q.limit) || 1000, 50_000);
    const params = new URLSearchParams({ keys: keys.join(','), startTs: String(startTs), endTs: String(endTs), agg, limit: String(limit), orderBy: q.orderBy === 'DESC' ? 'DESC' : 'ASC' });
    if (agg !== 'NONE') {
      const interval = Number(q.interval) || 3600_000;
      if (interval < 1000) throw new ApiError(400, 'interval minimal 1000 ms');
      params.set('interval', String(interval));
    }
    const raw = await this.#tenant('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?${params}`);
    const out = {};
    for (const [k, arr] of Object.entries(raw ?? {})) out[k] = arr.map((p) => ({ ts: p.ts, value: toValue(p.value) }));
    return { startTs, endTs, agg, data: out };
  }

  async attributes(client, buildingId, deviceId, { scope, keys }) {
    await this.requireDevice(client, buildingId, deviceId);
    const sc = (scope ?? 'CLIENT_SCOPE').toUpperCase();
    if (!['CLIENT_SCOPE', 'SHARED_SCOPE', 'SERVER_SCOPE'].includes(sc)) throw new ApiError(400, 'scope harus CLIENT_SCOPE|SHARED_SCOPE|SERVER_SCOPE');
    const k = parseKeys(keys);
    const qs = k.length ? `?keys=${encodeURIComponent(k.join(','))}` : '';
    const r = await this.#tenant('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/${sc}${qs}`);
    return Object.fromEntries((r ?? []).map((a) => [a.key, { ts: a.lastUpdateTs, value: toValue(a.value) }]));
  }

  // ---------- alarm ----------

  async alarms(client, buildingId, { status, limit, days } = {}) {
    const topo = await this.requireBuilding(client, buildingId);
    return this.alarmsForTopology(topo, { status, limit, days });
  }

  async alarmsForTopology(topo, { status, limit, days } = {}) {
    const statusList = parseKeys(status ?? 'ACTIVE').map((s) => s.toUpperCase());
    for (const s of statusList) if (!ALARM_STATUS.has(s)) throw new ApiError(400, `status harus: ${[...ALARM_STATUS].join(', ')}`);
    const ids = [...topo.devices.keys()];
    if (ids.length === 0) return [];
    const r = await this.#tenant('POST', '/api/alarmsQuery/find', {
      entityFilter: { type: 'entityList', entityType: 'DEVICE', entityList: ids },
      pageLink: {
        page: 0,
        pageSize: Math.min(Number(limit) || 100, 500),
        searchPropagatedAlarms: false,
        statusList,
        severityList: [],
        typeList: [],
        timeWindow: Math.min(Number(days) || 30, 365) * 86400_000,
        sortOrder: { key: { type: 'ALARM_FIELD', key: 'createdTime' }, direction: 'DESC' },
      },
      alarmFields: ['createdTime', 'type', 'severity', 'status', 'originator'].map((key) => ({ type: 'ALARM_FIELD', key })),
      entityFields: [],
      latestValues: [],
    });
    return (r.data ?? []).map((a) => ({
      id: a.id?.id,
      type: a.type,
      severity: a.severity,
      status: a.status,
      acknowledged: a.acknowledged ?? null,
      cleared: a.cleared ?? null,
      deviceId: a.originator?.id,
      deviceName: a.originatorName ?? topo.devices.get(a.originator?.id)?.name ?? null,
      createdTime: a.createdTime,
      details: a.details ?? null,
    }));
  }

  // ---------- RPC ----------

  async rpc(client, buildingId, deviceId, body) {
    await this.requireDevice(client, buildingId, deviceId);
    const method = body.method;
    if (typeof method !== 'string' || !/^[\w.\-]{1,64}$/.test(method)) throw new ApiError(400, 'method wajib');
    if (client.rpcMethods && !client.rpcMethods.has(method)) throw new ApiError(403, `method RPC "${method}" tidak diizinkan untuk client ini`);
    const timeout = Math.min(Math.max(Number(body.timeout) || 10_000, 1000), 30_000);
    const kind = body.oneway ? 'oneway' : 'twoway';
    try {
      const r = await this.tb.asTenant('POST', `/api/plugins/rpc/${kind}/${deviceId}`, {
        method,
        params: body.params ?? {},
        timeout,
      });
      return { ok: true, response: r ?? null };
    } catch (e) {
      if (e instanceof TbError && [408, 504].includes(e.status)) throw new ApiError(504, 'device tidak merespons (timeout / offline)');
      if (e instanceof TbError && e.status === 400) throw new ApiError(400, e.message);
      throw e;
    }
  }

  // ---------- dashboard ----------

  async dashboards(client, buildingId) {
    await this.requireBuilding(client, buildingId);
    const attrs = await this.#tenant('GET', `/api/plugins/telemetry/ASSET/${buildingId}/values/attributes/SERVER_SCOPE?keys=dashboards`);
    let list = toValue(attrs?.find((a) => a.key === 'dashboards')?.value ?? []);
    if (!Array.isArray(list)) list = [];
    const entries = list
      .map((d) => (typeof d === 'string' ? { id: d } : d))
      .filter((d) => d && typeof d.id === 'string' && /^[0-9a-f-]{36}$/i.test(d.id));
    const infos = await mapLimit(entries, 5, async (d) => {
      try {
        const info = await this.tb.asTenant('GET', `/api/dashboard/info/${d.id}`);
        return { id: d.id.toLowerCase(), title: d.title ?? info.title, stateId: d.stateId ?? null };
      } catch {
        return null; // dashboard terhapus -> abaikan
      }
    });
    return infos.filter(Boolean);
  }
}
