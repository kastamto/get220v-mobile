import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createApp, buildState } from '../src/server.js';
import { validateApps } from '../src/config.js';

const CUSTOMER = 'aaaaaaaa-0000-0000-0000-000000000001';
const PUBLIC_CUSTOMER = 'bbbbbbbb-0000-0000-0000-000000000002';
const EMBED_USER = 'cccccccc-0000-0000-0000-000000000003';
const DASH_OK = 'dddddddd-0000-0000-0000-000000000004';
const DASH_OTHER = 'eeeeeeee-0000-0000-0000-000000000005';
const DASH_PUBLIC = 'ffffffff-0000-0000-0000-000000000006';
const DEVICE = '12345678-0000-0000-0000-000000000007';

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 9000, ...payload })}.sig`;
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

const dashboards = {
  [DASH_OK]: { id: { id: DASH_OK }, title: 'Fleet Pompa', assignedCustomers: [{ customerId: { id: CUSTOMER }, public: false }] },
  [DASH_OTHER]: { id: { id: DASH_OTHER }, title: 'Internal', assignedCustomers: [] },
  [DASH_PUBLIC]: { id: { id: DASH_PUBLIC }, title: 'Lobby', assignedCustomers: [{ customerId: { id: PUBLIC_CUSTOMER }, public: true }] },
};

const calls = [];
let tb, tbUrl, svc, svcUrl;

before(async () => {
  const tenantToken = jwt({ scopes: ['TENANT_ADMIN'] });
  const userToken = jwt({ scopes: ['CUSTOMER_USER'], customerId: CUSTOMER, userId: EMBED_USER });
  tb = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push(`${req.method} ${req.url}`);
    const auth = req.headers['x-authorization'];
    const json = (s, d) => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    if (req.url === '/api/auth/login') {
      const { username, password } = JSON.parse(body);
      return username === 'tenant@x' && password === 'pw'
        ? json(200, { token: tenantToken, refreshToken: 'tenant-rt' })
        : json(401, { message: 'bad creds' });
    }
    if (req.url === `/api/user/${EMBED_USER}/token` && auth === `Bearer ${tenantToken}`) {
      return json(200, { token: userToken, refreshToken: 'user-rt' });
    }
    const m = req.url.match(/^\/api\/dashboard\/info\/(.+)$/);
    if (m) {
      const d = dashboards[m[1]];
      if (!d) return json(404, { message: 'not found' });
      if (auth === `Bearer ${tenantToken}`) return json(200, d);
      if (auth === `Bearer ${userToken}`) {
        return d.assignedCustomers.some((c) => c.customerId.id === CUSTOMER) ? json(200, d) : json(403, { message: 'denied' });
      }
      return json(401, {});
    }
    if (req.url.startsWith(`/api/customer/${CUSTOMER}/dashboards`) && auth === `Bearer ${userToken}`) {
      return json(200, { data: [dashboards[DASH_OK]], totalElements: 1, totalPages: 1, hasNext: false });
    }
    if (req.url.startsWith('/api/tenant/dashboards') && auth === `Bearer ${tenantToken}`) {
      return json(200, { data: Object.values(dashboards), totalElements: 3, totalPages: 1, hasNext: false });
    }
    json(404, { message: 'mock: unknown route' });
  });
  await new Promise((r) => tb.listen(0, '127.0.0.1', r));
  tbUrl = `http://127.0.0.1:${tb.address().port}`;

  const config = {
    tbInternalUrl: tbUrl,
    tbPublicUrl: 'https://iot.example.com',
    publicBaseUrl: 'https://iot.example.com/dash-embed',
    tbUsername: 'tenant@x',
    tbPassword: 'pw',
    ticketTtlSec: 60,
    minSessionSec: 1800,
    rateLimitPerMin: 1000,
    apps: validateApps({
      apps: [
        {
          id: 'portal',
          keySha256: sha('key-portal'),
          mode: 'user',
          tbUserId: EMBED_USER,
          allowedDashboards: ['*'],
          allowedOrigins: ['https://portal.example.com'],
          defaultParams: { hideToolbar: true },
        },
        {
          id: 'limited',
          keySha256: sha('key-limited'),
          mode: 'user',
          tbUserId: EMBED_USER,
          allowedDashboards: [DASH_OK],
        },
        { id: 'lobby', keySha256: sha('key-lobby'), mode: 'public', allowedDashboards: ['*'] },
      ],
    }),
  };
  ({ server: svc } = createApp(config));
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  svcUrl = `http://127.0.0.1:${svc.address().port}`;
});

after(() => {
  svc.close();
  tb.close();
});

const embed = (key, body, headers = {}) =>
  fetch(`${svcUrl}/api/v1/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Api-Key': key } : {}), ...headers },
    body: JSON.stringify(body),
  });

test('health', async () => {
  const r = await fetch(`${svcUrl}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

test('tanpa / salah API key ditolak', async () => {
  assert.equal((await embed(null, { dashboardId: DASH_OK })).status, 401);
  assert.equal((await embed('salah', { dashboardId: DASH_OK })).status, 401);
});

test('mode user: embed -> ticket sekali pakai -> redirect ke TB dengan token user (bukan admin)', async () => {
  const r = await embed('key-portal', { dashboardId: DASH_OK }, { Origin: 'https://portal.example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://portal.example.com');
  const j = await r.json();
  assert.equal(j.dashboard.title, 'Fleet Pompa');
  assert.match(j.embedUrl, /^https:\/\/iot\.example\.com\/dash-embed\/e\/[A-Za-z0-9_-]{32}$/);
  assert.ok(j.sessionExpiresAt);
  assert.ok(!JSON.stringify(j).includes('accessToken'), 'token tidak boleh ada di response JSON');

  const ticketPath = new URL(j.embedUrl).pathname; // /dash-embed/e/...
  const go = await fetch(`${svcUrl}${ticketPath}`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, `https://iot.example.com/dashboard/${DASH_OK}`);
  const payload = JSON.parse(Buffer.from(loc.searchParams.get('accessToken').split('.')[1], 'base64url'));
  assert.deepEqual(payload.scopes, ['CUSTOMER_USER']);
  assert.equal(loc.searchParams.get('refreshToken'), null);
  assert.equal(loc.searchParams.get('hideToolbar'), 'true');
  assert.equal(go.headers.get('referrer-policy'), 'no-referrer');

  const again = await fetch(`${svcUrl}${ticketPath}`, { redirect: 'manual' });
  assert.equal(again.status, 410);
});

test('mode user: dashboard yang tidak di-assign ke customer user -> 403 dari TB', async () => {
  const r = await embed('key-portal', { dashboardId: DASH_OTHER });
  assert.equal(r.status, 403);
});

test('allowlist app ditegakkan sebelum menyentuh TB', async () => {
  const r = await embed('key-limited', { dashboardId: DASH_PUBLIC });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /tidak diizinkan/);
});

test('validasi input', async () => {
  assert.equal((await embed('key-portal', { dashboardId: 'x' })).status, 400);
  assert.equal((await embed('key-portal', { dashboardId: DASH_OK, entity: { id: DEVICE, entityType: 'BAD' } })).status, 400);
  const bad = await fetch(`${svcUrl}/api/v1/embed`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'key-portal' },
    body: '{nope',
  });
  assert.equal(bad.status, 400);
});

test('state entity per device dibangun sesuai format TB', async () => {
  const r = await embed('key-portal', {
    dashboardId: DASH_OK,
    hideToolbar: false,
    stateId: 'device_detail',
    entity: { id: DEVICE, entityType: 'DEVICE' },
    entityName: 'Pompa Dwi Warna',
  });
  const j = await r.json();
  const go = await fetch(`${svcUrl}${new URL(j.embedUrl).pathname}`, { redirect: 'manual' });
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.searchParams.get('hideToolbar'), 'false');
  const state = JSON.parse(Buffer.from(loc.searchParams.get('state'), 'base64').toString('utf8'));
  assert.deepEqual(state, [
    { id: 'device_detail', params: { entityId: { id: DEVICE, entityType: 'DEVICE' }, entityName: 'Pompa Dwi Warna' } },
  ]);
  assert.equal(loc.searchParams.get('state'), buildState({ stateId: 'device_detail', entity: { id: DEVICE, entityType: 'DEVICE' }, entityName: 'Pompa Dwi Warna' }));
});

test('mode public: pakai publicId, tanpa token; dashboard non-public ditolak', async () => {
  const ok = await embed('key-lobby', { dashboardId: DASH_PUBLIC });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.publicUrl, `https://iot.example.com/dashboard/${DASH_PUBLIC}?publicId=${PUBLIC_CUSTOMER}`);
  assert.equal((await embed('key-lobby', { dashboardId: DASH_OK })).status, 403);
});

test('list dashboard: user -> dashboard customer; public -> hanya yang public; allowlist -> hanya yang diizinkan', async () => {
  const get = (key) => fetch(`${svcUrl}/api/v1/dashboards`, { headers: { 'X-Api-Key': key } }).then((r) => r.json());
  assert.deepEqual((await get('key-portal')).data.map((d) => d.id), [DASH_OK]);
  assert.deepEqual((await get('key-lobby')).data.map((d) => d.id), [DASH_PUBLIC]);
  const lim = await get('key-limited');
  assert.deepEqual(lim.data.map((d) => d.id), [DASH_OK]);
  assert.equal(lim.totalElements, 1);
});

test('token admin & user di-cache (login TB tidak diulang tiap request)', async () => {
  const logins = calls.filter((c) => c === 'POST /api/auth/login').length;
  const userTokens = calls.filter((c) => c.startsWith('GET /api/user/')).length;
  assert.equal(logins, 1);
  assert.equal(userTokens, 1);
});
