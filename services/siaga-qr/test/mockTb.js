// ThingsBoard tiruan: hanya endpoint yang dipakai service, dengan aturan akses ala TB.
import { createServer } from 'node:http';

export const T1 = '71000000-0000-0000-0000-000000000001';
export const T2 = '72000000-0000-0000-0000-000000000002';
export const CU1 = 'c1000000-0000-0000-0000-000000000001';
export const CU2 = 'c2000000-0000-0000-0000-000000000002';
export const D1 = 'd1000000-0000-0000-0000-000000000001'; // T1, milik CU1
export const D2 = 'd2000000-0000-0000-0000-000000000002'; // T1, belum di-assign
export const D3 = 'd3000000-0000-0000-0000-000000000003'; // T2
const NULL_UUID = '13814000-1dd2-11b2-8080-808080808080';

const tok = (name) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS512' })}.${enc({ sub: name, exp: Math.floor(Date.now() / 1000) + 9000 })}.sig-${name}`;
};

export const TOKENS = {
  adminA: tok('adminA'),
  adminB: tok('adminB'),
  cust1: tok('cust1'),
  cust2: tok('cust2'),
  sys: tok('sys'),
  expired: tok('expired'),
};

const USERS = {
  [TOKENS.adminA]: { id: { id: 'a1000000-0000-0000-0000-000000000001' }, authority: 'TENANT_ADMIN', tenantId: { id: T1 }, customerId: { id: NULL_UUID }, email: 'admin@t1', firstName: 'Admin', lastName: 'Satu' },
  [TOKENS.adminB]: { id: { id: 'a2000000-0000-0000-0000-000000000002' }, authority: 'TENANT_ADMIN', tenantId: { id: T2 }, customerId: { id: NULL_UUID }, email: 'admin@t2' },
  [TOKENS.cust1]: { id: { id: 'b1000000-0000-0000-0000-000000000001' }, authority: 'CUSTOMER_USER', tenantId: { id: T1 }, customerId: { id: CU1 }, email: 'c1@x' },
  [TOKENS.cust2]: { id: { id: 'b2000000-0000-0000-0000-000000000002' }, authority: 'CUSTOMER_USER', tenantId: { id: T1 }, customerId: { id: CU2 }, email: 'c2@x' },
  [TOKENS.sys]: { id: { id: 'f0000000-0000-0000-0000-000000000001' }, authority: 'SYS_ADMIN', tenantId: { id: NULL_UUID }, customerId: { id: NULL_UUID } },
};

export async function startMockTb({ extraT1Devices = 0 } = {}) {
  const devices = {
    [D1]: { name: 'MURAYA-GWT-01', tenant: T1, customer: CU1, attrs: [{ key: 'building', value: 'Muraya' }] },
    [D2]: { name: 'AMANI-DOOR-01', tenant: T1, customer: null, attrs: [] },
    [D3]: { name: 'OTHER-TENANT-01', tenant: T2, customer: null, attrs: [] },
  };
  for (let i = 0; i < extraT1Devices; i++) {
    devices[`e0000000-0000-0000-0000-${String(i).padStart(12, '0')}`] = { name: `BULK-${i}`, tenant: T1, customer: null, attrs: [] };
  }
  const state = { devices, calls: [], down: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.calls.push(`${req.method} ${url.pathname}`);
    const json = (s, d) => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    if (state.down) return json(503, { message: 'down' });
    const user = USERS[String(req.headers['x-authorization']).replace(/^Bearer /, '')];
    if (!user) return json(401, { message: 'Token has expired' });
    if (url.pathname === '/api/auth/user') return json(200, user);
    const canSee = (d) =>
      d && (user.authority === 'TENANT_ADMIN' ? d.tenant === user.tenantId.id : user.authority === 'CUSTOMER_USER' && d.customer === user.customerId.id);
    let m;
    if ((m = url.pathname.match(/^\/api\/device\/([^/]+)$/))) {
      const d = devices[m[1]];
      if (!d) return json(404, { message: 'not found' });
      if (!canSee(d)) return json(403, { message: 'denied' });
      return json(200, { id: { id: m[1] }, name: d.name, tenantId: { id: d.tenant }, customerId: { id: d.customer ?? NULL_UUID } });
    }
    if ((m = url.pathname.match(/^\/api\/plugins\/telemetry\/DEVICE\/([^/]+)\/values\/attributes\/SERVER_SCOPE$/))) {
      const d = devices[m[1]];
      if (!canSee(d)) return json(403, { message: 'denied' });
      return json(200, d.attrs);
    }
    if (url.pathname === '/api/tenant/devices') {
      if (user.authority !== 'TENANT_ADMIN') return json(403, { message: 'denied' });
      const all = Object.entries(devices).filter(([, d]) => d.tenant === user.tenantId.id);
      const size = Number(url.searchParams.get('pageSize'));
      const page = Number(url.searchParams.get('page'));
      const slice = all.slice(page * size, page * size + size);
      return json(200, { data: slice.map(([id, d]) => ({ id: { id }, name: d.name })), hasNext: (page + 1) * size < all.length });
    }
    json(404, { message: `mock: ${url.pathname}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, state };
}
