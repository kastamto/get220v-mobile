// ThingsBoard tiruan untuk test — hanya endpoint yang dipakai gateway.
import { createServer } from 'node:http';

export const ID = {
  B1: 'b1000000-0000-0000-0000-000000000001',
  B2: 'b2000000-0000-0000-0000-000000000002',
  ROOM: 'a0000000-0000-0000-0000-00000000000f', // asset bukan building
  F1: 'f1000000-0000-0000-0000-000000000001',
  DEV1: 'd1000000-0000-0000-0000-000000000001',
  DEV2: 'd2000000-0000-0000-0000-000000000002',
  DEV3: 'd3000000-0000-0000-0000-000000000003',
  DASH1: 'da000000-0000-0000-0000-000000000001',
  DASH_GONE: 'da000000-0000-0000-0000-0000000000ff',
  EMBED_USER: 'e0000000-0000-0000-0000-000000000001',
  CUSTOMER: 'c0000000-0000-0000-0000-000000000001',
};

export function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 9000, ...payload })}.sig`;
}

export async function startMockTb() {
  const tenantToken = jwt({ scopes: ['TENANT_ADMIN'] });
  const userToken = jwt({ scopes: ['CUSTOMER_USER'], customerId: ID.CUSTOMER });
  const state = {
    calls: [],
    alarms: [{ id: { id: 'al000000-0000-0000-0000-000000000001' }, type: 'High Temp', severity: 'MAJOR', status: 'ACTIVE_UNACK', originator: { id: ID.DEV1, entityType: 'DEVICE' }, originatorName: 'Pompa A', createdTime: 1 }],
    rpcCalls: [],
    tenantToken,
    userToken,
  };
  const assets = {
    [ID.B1]: { id: { id: ID.B1 }, name: 'Rukita Amani', label: 'Jaksel', type: 'building' },
    [ID.B2]: { id: { id: ID.B2 }, name: 'Rukita Bintaro', type: 'building' },
    [ID.ROOM]: { id: { id: ID.ROOM }, name: 'Gudang', type: 'room' },
    [ID.F1]: { id: { id: ID.F1 }, name: 'Lantai 1', type: 'space' },
  };
  const devices = {
    [ID.DEV1]: { id: { id: ID.DEV1 }, name: 'Pompa A', label: 'Pompa Dwi Warna', type: 'pump' },
    [ID.DEV2]: { id: { id: ID.DEV2 }, name: 'Gerbang', type: 'door' },
    [ID.DEV3]: { id: { id: ID.DEV3 }, name: 'Meter Bintaro', type: 'meter' },
  };
  const nameOf = (id) => assets[id]?.name ?? devices[id]?.name ?? null;
  // relasi disimpan sebagai edge supaya bisa ditambah/dihapus (bulk/undo)
  const edges = [
    { from: ID.B1, to: ID.F1, toType: 'ASSET' },
    { from: ID.F1, to: ID.DEV1, toType: 'DEVICE' },
    { from: ID.B1, to: ID.DEV2, toType: 'DEVICE' },
    { from: ID.B2, to: ID.DEV3, toType: 'DEVICE' },
  ];
  state.edges = edges;
  state.assets = assets;
  state.serverAttrs = {}; // deviceId -> {key: value}
  // TB sungguhan menyusuri relasi "Contains" secara rekursif dari entity APAPUN (asset atau
  // device) selama entityTypes filter mengizinkannya, bukan cuma dari asset — makanya relasi
  // device->device lama ikut ketarik kalau tidak difilter di sisi client. Tiru itu di sini.
  const entityType = (id) => (assets[id] ? 'ASSET' : 'DEVICE');
  const relationsFrom = (root, maxLevel) => {
    const out = [];
    let frontier = [root];
    const seen = new Set([root]);
    for (let lvl = 0; lvl < maxLevel && frontier.length; lvl++) {
      const next = [];
      for (const f of frontier) {
        for (const e of edges.filter((x) => x.from === f)) {
          out.push({ from: { id: e.from, entityType: entityType(e.from) }, to: { id: e.to, entityType: e.toType }, type: 'Contains', toName: nameOf(e.to) });
          if (!seen.has(e.to)) {
            seen.add(e.to);
            next.push(e.to);
          }
        }
      }
      frontier = next;
    }
    return out;
  };
  const latest = {
    [ID.DEV1]: { current_a: [{ ts: 10, value: '2.5' }], running: [{ ts: 10, value: 'true' }], mode: [{ ts: 10, value: 'auto' }] },
    [ID.DEV2]: { door: [{ ts: 11, value: 'open' }] },
    [ID.DEV3]: { kwh: [{ ts: 12, value: '1000' }] },
  };

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.calls.push(`${req.method} ${p}`);
    const auth = req.headers['x-authorization'];
    const isTenant = auth === `Bearer ${tenantToken}`;
    const isUser = auth === `Bearer ${userToken}`;
    const json = (s, d) => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(d === undefined ? '' : JSON.stringify(d));
    };
    if (p === '/api/auth/login') {
      const b = JSON.parse(body);
      return b.username === 'tenant@x' && b.password === 'pw' ? json(200, { token: tenantToken, refreshToken: 'rt' }) : json(401, { message: 'bad' });
    }
    if (!isTenant && !isUser) return json(401, { message: 'unauthorized' });

    if (p === `/api/user/${ID.EMBED_USER}/token` && isTenant) return json(200, { token: userToken, refreshToken: 'user-rt' });

    if (p === '/api/tenant/assets' && isTenant) {
      const data = Object.values(assets).filter((a) => a.type === url.searchParams.get('type'));
      return json(200, { data, totalElements: data.length, totalPages: 1, hasNext: false });
    }
    let m;
    if ((m = p.match(/^\/api\/asset\/(.+)$/))) {
      if (req.method === 'DELETE') {
        delete assets[m[1]];
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === m[1] || edges[i].to === m[1]) edges.splice(i, 1);
        return json(200);
      }
      const a = assets[m[1]];
      if (!a) return json(404, { message: 'nf' });
      if (isUser && m[1] !== ID.B1) return json(403, { message: 'denied' });
      return json(200, a);
    }
    if (p === '/api/relations/info' && isTenant) {
      const q = JSON.parse(body).parameters;
      return json(200, relationsFrom(q.rootId, q.maxLevel));
    }
    if (p === '/api/tenant/deviceInfos' && isTenant) {
      const data = Object.values(devices).map((d) => ({ ...d, customerTitle: d.id.id === ID.DEV3 ? 'Bintaro Owner' : null, customerIsPublic: false }));
      return json(200, { data, totalElements: data.length, hasNext: false });
    }
    if (p === '/api/asset' && req.method === 'POST' && isTenant) {
      const a = JSON.parse(body);
      const id = `a${String(Object.keys(assets).length).padStart(7, '0')}-0000-0000-0000-000000000000`;
      assets[id] = { id: { id }, name: a.name, label: a.label, type: a.type };
      return json(200, assets[id]);
    }
    if (p === '/api/relation' && isTenant) {
      if (req.method === 'POST') {
        const r = JSON.parse(body);
        edges.push({ from: r.from.id, to: r.to.id, toType: r.to.entityType });
        return json(200);
      }
      if (req.method === 'DELETE') {
        const q = url.searchParams;
        const i = edges.findIndex((e) => e.from === q.get('fromId') && e.to === q.get('toId'));
        if (i < 0) return json(404, { message: 'relation nf' });
        edges.splice(i, 1);
        return json(200);
      }
    }
    if ((m = p.match(/^\/api\/plugins\/telemetry\/DEVICE\/([^/]+)\/(attributes\/)?SERVER_SCOPE$/)) && isTenant && req.method !== 'GET') {
      if (req.method === 'POST') state.serverAttrs[m[1]] = { ...state.serverAttrs[m[1]], ...JSON.parse(body) };
      else for (const k of url.searchParams.get('keys').split(',')) delete state.serverAttrs[m[1]]?.[k];
      return json(200);
    }
    if (p === '/api/entitiesQuery/find' && isTenant) {
      const q = JSON.parse(body);
      const data = q.entityFilter.entityList.map((id) => ({
        entityId: { id, entityType: 'DEVICE' },
        latest: {
          ENTITY_FIELD: { name: { ts: 0, value: devices[id].name }, label: { ts: 0, value: devices[id].label ?? '' }, type: { ts: 0, value: devices[id].type } },
          SERVER_ATTRIBUTE: { active: { ts: 0, value: id === ID.DEV1 ? 'true' : 'false' }, lastActivityTime: { ts: 0, value: '1700000000000' } },
        },
      }));
      return json(200, { data, totalElements: data.length, hasNext: false });
    }
    if ((m = p.match(/^\/api\/device\/(.+)$/))) {
      if (isUser && m[1] !== ID.DEV1) return json(403, { message: 'denied' });
      return devices[m[1]] ? json(200, devices[m[1]]) : json(404, { message: 'nf' });
    }
    if ((m = p.match(/^\/api\/plugins\/telemetry\/DEVICE\/(.+)\/keys\/timeseries$/))) return json(200, Object.keys(latest[m[1]] ?? {}));
    if ((m = p.match(/^\/api\/plugins\/telemetry\/DEVICE\/(.+)\/values\/timeseries$/))) {
      const all = latest[m[1]] ?? {};
      const keys = url.searchParams.get('keys');
      if (url.searchParams.get('startTs')) {
        const out = {};
        for (const k of keys.split(',')) out[k] = [{ ts: 1, value: '1.5' }, { ts: 2, value: '2.5' }];
        return json(200, out);
      }
      return json(200, keys ? Object.fromEntries(keys.split(',').filter((k) => all[k]).map((k) => [k, all[k]])) : all);
    }
    if ((m = p.match(/^\/api\/plugins\/telemetry\/DEVICE\/(.+)\/values\/attributes\/(.+)$/))) {
      return json(200, [{ key: 'fw', value: '1.2.0', lastUpdateTs: 5 }]);
    }
    if ((m = p.match(/^\/api\/plugins\/telemetry\/ASSET\/(.+)\/values\/attributes\/SERVER_SCOPE$/))) {
      const attrs = [{ key: 'address', value: 'Jl. Amani 1', lastUpdateTs: 1 }];
      if (m[1] === ID.B1) attrs.push({ key: 'dashboards', value: JSON.stringify([{ id: ID.DASH1, stateId: 'building' }, ID.DASH_GONE]), lastUpdateTs: 1 });
      const keys = url.searchParams.get('keys');
      return json(200, keys ? attrs.filter((a) => keys.split(',').includes(a.key)) : attrs);
    }
    if (p === '/api/alarmsQuery/find' && isTenant) {
      const ids = new Set(JSON.parse(body).entityFilter.entityList);
      const data = state.alarms.filter((a) => ids.has(a.originator.id));
      return json(200, { data, totalElements: data.length, hasNext: false });
    }
    if ((m = p.match(/^\/api\/plugins\/rpc\/(oneway|twoway)\/(.+)$/))) {
      state.rpcCalls.push({ kind: m[1], deviceId: m[2], body: JSON.parse(body) });
      if (m[2] === ID.DEV2) return json(504, { message: 'timeout' });
      return m[1] === 'twoway' ? json(200, { relay: 'on' }) : json(200);
    }
    if ((m = p.match(/^\/api\/dashboard\/info\/(.+)$/))) {
      if (m[1] === ID.DASH1) return json(200, { id: { id: ID.DASH1 }, title: 'Building Overview' });
      return json(404, { message: 'nf' });
    }
    json(404, { message: `mock: ${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, state };
}

/** WebSocket palsu yang bisa dikendalikan dari test. */
export class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    FakeWS.instances.push(this);
    setTimeout(() => this.emit('open', {}), 0);
  }
  addEventListener(t, fn) {
    (this.listeners[t] ??= []).push(fn);
  }
  emit(t, ev) {
    for (const fn of this.listeners[t] ?? []) fn(ev);
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.emit('close', {});
  }
  push(obj) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}
