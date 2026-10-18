import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGatewayServer } from '../src/server.js';
import { validateClients } from '../src/config.js';
import { startMockTb, jwt, ID } from './mockTb.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
let tb, gw, base;
const ADMIN = jwt({ scopes: ['TENANT_ADMIN'], tenantId: ID.TENANT, sub: 'kas' });
const OTHER_TENANT = jwt({ scopes: ['TENANT_ADMIN'], tenantId: 'other' });
const EXPIRED = jwt({ scopes: ['TENANT_ADMIN'], tenantId: ID.TENANT, sub: 'old' });
const CUSTOMER = jwt({ scopes: ['CUSTOMER_USER'], tenantId: ID.TENANT });

before(async () => {
  tb = await startMockTb();
  tb.state.authUsers[ADMIN] = { authority: 'TENANT_ADMIN', email: 'kas@get220v.id', firstName: 'Kas', tenantId: { id: ID.TENANT } };
  tb.state.authUsers[OTHER_TENANT] = { authority: 'TENANT_ADMIN', email: 'x@other', tenantId: { id: 'other' } };
  tb.state.authUsers[CUSTOMER] = { authority: 'CUSTOMER_USER', email: 'c@x', tenantId: { id: ID.TENANT } };
  ({ server: gw } = createGatewayServer(
    {
      tbInternalUrl: tb.url, tbWsUrl: 'ws://fake', tbPublicUrl: 'https://iot.example.com', publicBaseUrl: 'https://iot.example.com/building-api',
      tbUsername: 'tenant@x', tbPassword: 'pw', buildingAssetType: 'building', relationType: 'Contains', maxLevel: 5, cacheSec: 60,
      ticketTtlSec: 60, minSessionSec: 1800, rateLimitPerMin: 1000, alarmPollSec: 3600, webhookBatchMs: 20, clientCacheSec: 30,
      clients: validateClients({ clients: [{ id: 'file-client', keySha256: sha('k-file'), buildings: [ID.B1], scopes: ['read'] }] }),
    },
    { log: { log() {}, error() {} } },
  ));
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}/building-api`;
});
after(() => {
  gw.close();
  gw.closeAllConnections();
  tb.server.close();
  tb.server.closeAllConnections();
});

const admin = (method, path, body, token = ADMIN) =>
  fetch(`${base}/admin/v1${path}`, {
    method,
    headers: { ...(token ? { 'X-Authorization': `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const api = (path, key) => fetch(`${base}${path}`, { headers: { 'X-Api-Key': key } });

test('admin hanya untuk tenant admin TB dari tenant yang sama, dengan token yang masih berlaku', async () => {
  assert.equal((await admin('GET', '/me', null, null)).status, 401);
  assert.equal((await admin('GET', '/me', null, 'bukan-jwt')).status, 401);
  assert.equal((await admin('GET', '/me', null, CUSTOMER)).status, 403);
  assert.equal((await admin('GET', '/me', null, OTHER_TENANT)).status, 403);
  assert.equal((await admin('GET', '/me', null, EXPIRED)).status, 401);
  const me = await admin('GET', '/me');
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: 'kas@get220v.id', name: 'Kas' });
});

test('meta: daftar gedung + scope (tanpa webhooks)', async () => {
  const m = await (await admin('GET', '/meta')).json();
  assert.deepEqual(m.buildings.map((b) => b.name), ['Rukita Amani', 'Rukita Bintaro']);
  assert.ok(!m.scopes.includes('webhooks'));
  assert.ok(m.scopes.includes('rpc'));
});

test('siklus hidup client dari web: buat -> pakai -> ubah -> rotasi -> nonaktif -> hapus', async () => {
  // buat
  const c = await admin('POST', '/clients', { id: 'portal', name: 'Portal Rukita', buildings: [ID.B1], scopes: ['read'] });
  assert.equal(c.status, 201);
  const { key } = await c.json();
  assert.match(key, /^g220v_[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(tb.state.serverAttrs).includes(key), 'key asli tidak boleh disimpan di TB');
  const asset = Object.values(tb.state.assets).find((a) => a.name === 'apiclient-portal');
  assert.equal(asset.type, 'api-client');
  assert.equal(tb.state.serverAttrs[asset.id.id].keySha256, sha(key));
  assert.equal(tb.state.serverAttrs[asset.id.id].createdBy, 'kas@get220v.id');

  const list = (await (await admin('GET', '/clients')).json()).data;
  assert.deepEqual(list.map((x) => [x.id, x.source]), [['file-client', 'file'], ['portal', 'thingsboard']]);
  assert.equal(list[1].keyHint, key.slice(0, 10));
  assert.ok(!JSON.stringify(list).includes('keySha256'));

  // langsung bisa dipakai, dibatasi gedung & scope
  const b = await (await api('/v1/buildings', key)).json();
  assert.deepEqual(b.data.map((x) => x.id), [ID.B1]);
  assert.equal((await api(`/v1/buildings/${ID.B1}/alarms`, key)).status, 403);

  // ubah: semua gedung + scope alarms + nama
  assert.equal((await admin('PATCH', '/clients/portal', { buildings: ['*'], scopes: ['read', 'alarms'], name: 'Portal Baru' })).status, 200);
  assert.equal((await (await api('/v1/buildings', key)).json()).data.length, 2);
  assert.equal((await api(`/v1/buildings/${ID.B1}/alarms`, key)).status, 200);
  assert.equal(tb.state.assets[asset.id.id].label, 'Portal Baru');

  // rotasi: key lama mati, key baru hidup
  const r = await (await admin('POST', '/clients/portal/rotate')).json();
  assert.notEqual(r.key, key);
  assert.equal((await api('/v1/buildings', key)).status, 401);
  assert.equal((await api('/v1/buildings', r.key)).status, 200);

  // nonaktif / aktif
  await admin('PATCH', '/clients/portal', { enabled: false });
  assert.equal((await api('/v1/buildings', r.key)).status, 401);
  await admin('PATCH', '/clients/portal', { enabled: true });
  assert.equal((await api('/v1/buildings', r.key)).status, 200);

  // hapus
  assert.equal((await admin('DELETE', '/clients/portal')).status, 200);
  assert.equal((await api('/v1/buildings', r.key)).status, 401);
  assert.ok(!Object.values(tb.state.assets).some((a) => a.name === 'apiclient-portal'));
});

test('validasi admin', async () => {
  assert.equal((await admin('POST', '/clients', { id: 'file-client', name: 'x', buildings: ['*'], scopes: ['read'] })).status, 409);
  assert.equal((await admin('POST', '/clients', { id: 'Bad Id', name: 'x', buildings: ['*'], scopes: ['read'] })).status, 400);
  assert.equal((await admin('POST', '/clients', { id: 'w1', name: 'x', buildings: ['*'], scopes: ['webhooks'] })).status, 400);
  assert.equal((await admin('POST', '/clients', { id: 'w2', name: 'x', buildings: ['bukan-uuid'], scopes: ['read'] })).status, 400);
  assert.equal((await admin('POST', '/clients', { id: 'w3', name: 'x', buildings: [], scopes: ['read'] })).status, 400);
  assert.equal((await admin('POST', '/clients', { id: 'dup', name: 'x', buildings: ['*'], scopes: ['read'] })).status, 201);
  assert.equal((await admin('POST', '/clients', { id: 'dup', name: 'x', buildings: ['*'], scopes: ['read'] })).status, 409);
  const f = await admin('PATCH', '/clients/file-client', { enabled: false });
  assert.equal(f.status, 404);
  assert.match((await f.json()).error, /clients\.json/);
  assert.equal((await admin('DELETE', '/clients/tidak-ada')).status, 404);
  // client dari file tetap jalan
  assert.equal((await api('/v1/buildings', 'k-file')).status, 200);
});

test('halaman admin: boleh di-frame oleh origin yang sama (dashboard TB), tidak oleh situs lain', async () => {
  const r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(await r.text(), /API Key Manager/);
});
