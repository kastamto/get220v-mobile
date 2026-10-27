import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { createGatewayServer } from '../src/server.js';
import { validateClients } from '../src/config.js';
import { RealtimeHub } from '../src/realtime.js';
import { startMockTb, FakeWS, ID } from './mockTb.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const quiet = { log() {}, error() {} };
let tb, gw, base, hub;

before(async () => {
  tb = await startMockTb();
  const config = {
    tbInternalUrl: tb.url,
    tbWsUrl: 'ws://fake/api/ws',
    tbPublicUrl: 'https://iot.example.com',
    publicBaseUrl: 'https://iot.example.com/building-api',
    tbUsername: 'tenant@x',
    tbPassword: 'pw',
    buildingAssetType: 'building',
    relationType: 'Contains',
    maxLevel: 5,
    cacheSec: 60,
    ticketTtlSec: 60,
    minSessionSec: 1800,
    rateLimitPerMin: 1000,
    alarmPollSec: 3600,
    webhookBatchMs: 20,
    clients: validateClients({
      clients: [
        {
          id: 'full',
          keySha256: sha('k-full'),
          buildings: ['*'],
          scopes: ['read', 'telemetry', 'history', 'attributes', 'alarms', 'stream', 'dashboards', 'rpc'],
          rpcMethods: ['setRelay'],
          embedUserId: ID.EMBED_USER,
        },
        { id: 'amani-only', keySha256: sha('k-amani'), buildings: [ID.B1], scopes: ['read'] },
        { id: 'auto-embed', keySha256: sha('k-auto'), buildings: ['*'], scopes: ['read', 'dashboards'] },
      ],
    }),
  };
  hub = new RealtimeHub({ wsUrl: config.tbWsUrl, getToken: async () => 'tok', WebSocketImpl: FakeWS, log: quiet, idleCloseMs: 10 });
  ({ server: gw } = createGatewayServer(config, { hub, log: quiet }));
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}/building-api`;
});

after(() => {
  gw.close();
  gw.closeAllConnections();
  tb.server.close();
  tb.server.closeAllConnections();
});

const get = (path, key = 'k-full') => fetch(`${base}${path}`, { headers: key ? { 'X-Api-Key': key } : {} });
const post = (path, body, key = 'k-full') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health & openapi tanpa auth', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const r = await fetch(`${base}/openapi.yaml`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /openapi: 3/);
});

test('auth: tanpa key 401, scope kurang 403', async () => {
  assert.equal((await get('/v1/buildings', null)).status, 401);
  assert.equal((await get('/v1/buildings', 'salah')).status, 401);
  assert.equal((await get(`/v1/buildings/${ID.B1}/alarms`, 'k-amani')).status, 403);
});

test('list building: hanya asset type building, difilter per client', async () => {
  const all = await (await get('/v1/buildings')).json();
  assert.deepEqual(all.data.map((b) => b.name), ['Rukita Amani', 'Rukita Bintaro']);
  const amani = await (await get('/v1/buildings', 'k-amani')).json();
  assert.deepEqual(amani.data.map((b) => b.id), [ID.B1]);
});

test('building lain & asset non-building tidak bisa diakses', async () => {
  assert.equal((await get(`/v1/buildings/${ID.B2}`, 'k-amani')).status, 403);
  assert.equal((await get(`/v1/buildings/${ID.ROOM}`)).status, 404);
});

test('detail building: atribut, jumlah device, lantai', async () => {
  const b = await (await get(`/v1/buildings/${ID.B1}`)).json();
  assert.equal(b.name, 'Rukita Amani');
  assert.equal(b.deviceCount, 2);
  assert.equal(b.attributes.address, 'Jl. Amani 1');
  assert.equal(b.attributes.dashboards, undefined);
  assert.deepEqual(b.spaces, [{ id: ID.F1, name: 'Lantai 1', parentId: ID.B1, path: [] }]);
});

test('device list: path lantai, status active, filter type/search', async () => {
  const r = await (await get(`/v1/buildings/${ID.B1}/devices`)).json();
  assert.deepEqual(r.data.map((d) => d.name), ['Gerbang', 'Pompa A']);
  const pompa = r.data.find((d) => d.id === ID.DEV1);
  assert.deepEqual(pompa.path, ['Lantai 1']);
  assert.equal(pompa.active, true);
  assert.equal(pompa.label, 'Pompa Dwi Warna');
  assert.equal(pompa.spaceId, ID.F1);
  assert.equal(r.data.find((d) => d.id === ID.DEV2).spaceId, null);
  const f = await (await get(`/v1/buildings/${ID.B1}/devices?type=door`)).json();
  assert.deepEqual(f.data.map((d) => d.id), [ID.DEV2]);
  const s = await (await get(`/v1/buildings/${ID.B1}/devices?search=dwi`)).json();
  assert.deepEqual(s.data.map((d) => d.id), [ID.DEV1]);
});

test('device dari building lain ditolak walau UUID valid', async () => {
  assert.equal((await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV3}`)).status, 404);
  assert.equal((await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV3}/telemetry/latest`)).status, 404);
});

test('relasi "Contains" device->device tidak ikut menarik device lain ke topologi building', async () => {
  // Data produksi nyata punya relasi Contains lama device->device yang tidak terkait topologi
  // building (dari fitur lain). Simulasikan: DEV2 (device B1) punya relasi Contains ke DEV3
  // (device B2 sesungguhnya). Topologi B1 harus tetap cuma 2 device — DEV3 tidak boleh "bocor"
  // masuk lewat jalur device->device ini.
  tb.state.edges.push({ from: ID.DEV2, to: ID.DEV3, toType: 'DEVICE' });
  try {
    const b = await (await get(`/v1/buildings/${ID.B1}`)).json();
    assert.equal(b.deviceCount, 2);
    const r = await (await get(`/v1/buildings/${ID.B1}/devices`)).json();
    assert.deepEqual(r.data.map((d) => d.id).sort(), [ID.DEV1, ID.DEV2].sort());
    assert.ok(!r.data.some((d) => d.id === ID.DEV3));
  } finally {
    tb.state.edges.pop();
  }
});

test('telemetry latest: nilai dikonversi ke tipe JSON', async () => {
  const r = await (await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/telemetry/latest`)).json();
  assert.deepEqual(r, { current_a: { ts: 10, value: 2.5 }, running: { ts: 10, value: true }, mode: { ts: 10, value: 'auto' } });
  const k = await (await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/telemetry/latest?keys=current_a`)).json();
  assert.deepEqual(Object.keys(k), ['current_a']);
});

test('snapshot latest seluruh building', async () => {
  const r = await (await get(`/v1/buildings/${ID.B1}/telemetry/latest`)).json();
  assert.equal(r.data.length, 2);
  assert.equal(r.data.find((d) => d.id === ID.DEV2).latest.door.value, 'open');
});

test('history: validasi & hasil', async () => {
  assert.equal((await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/telemetry`)).status, 400);
  assert.equal((await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/telemetry?keys=a&agg=BAD`)).status, 400);
  const r = await (await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/telemetry?keys=current_a&startTs=0&endTs=100000`)).json();
  assert.deepEqual(r.data.current_a, [{ ts: 1, value: 1.5 }, { ts: 2, value: 2.5 }]);
});

test('detail device & attributes', async () => {
  const d = await (await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}`)).json();
  assert.deepEqual(d.telemetryKeys, ['current_a', 'running', 'mode']);
  assert.deepEqual(d.path, ['Lantai 1']);
  const a = await (await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/attributes?scope=shared_scope`)).json();
  assert.deepEqual(a, { fw: { ts: 5, value: '1.2.0' } });
  assert.equal((await get(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/attributes?scope=x`)).status, 400);
});

test('alarm hanya dari device building tsb', async () => {
  const a = await (await get(`/v1/buildings/${ID.B1}/alarms`)).json();
  assert.equal(a.data.length, 1);
  assert.equal(a.data[0].deviceName, 'Pompa A');
  const b = await (await get(`/v1/buildings/${ID.B2}/alarms`)).json();
  assert.equal(b.data.length, 0);
});

test('RPC: allowlist method, timeout -> 504', async () => {
  const ok = await post(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/rpc`, { method: 'setRelay', params: { on: true } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, response: { relay: 'on' } });
  assert.deepEqual(tb.state.rpcCalls.at(-1).body, { method: 'setRelay', params: { on: true }, timeout: 10000 });
  assert.equal((await post(`/v1/buildings/${ID.B1}/devices/${ID.DEV1}/rpc`, { method: 'reboot' })).status, 403);
  assert.equal((await post(`/v1/buildings/${ID.B1}/devices/${ID.DEV2}/rpc`, { method: 'setRelay' })).status, 504);
});

test('dashboard building + embed dengan state entity building', async () => {
  const list = await (await get(`/v1/buildings/${ID.B1}/dashboards`)).json();
  assert.deepEqual(list.data, [{ id: ID.DASH1, title: 'Building Overview', stateId: 'building', source: 'manual' }]);

  const r = await post(`/v1/buildings/${ID.B1}/dashboards/${ID.DASH1}/embed`, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(!JSON.stringify(j).includes(tb.state.userToken));
  const go = await fetch(`http://127.0.0.1:${gw.address().port}${new URL(j.embedUrl).pathname}`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.pathname, `/dashboard/${ID.DASH1}`);
  assert.equal(loc.searchParams.get('accessToken'), tb.state.userToken);
  assert.equal(loc.searchParams.get('hideToolbar'), 'true');
  const st = JSON.parse(Buffer.from(loc.searchParams.get('state'), 'base64').toString());
  assert.deepEqual(st, [{ id: 'building', params: { entityId: { id: ID.B1, entityType: 'ASSET' }, entityName: 'Rukita Amani' } }]);
  assert.equal((await fetch(go.url, { redirect: 'manual' })).status, 410);

  // device yang tidak di-assign ke user embed -> 403
  assert.equal((await post(`/v1/buildings/${ID.B1}/dashboards/${ID.DASH1}/embed`, { deviceId: ID.DEV2 })).status, 403);
  // dashboard yang tidak terdaftar di building -> 404
  assert.equal((await post(`/v1/buildings/${ID.B2}/dashboards/${ID.DASH1}/embed`, {})).status, 404);
});

test('dashboard otomatis: dari customer pemilik device + user embed dibuat sekali', async () => {
  // B2 tanpa atribut "dashboards": dashboard customer pemilik Meter Bintaro
  const list = await (await get(`/v1/buildings/${ID.B2}/dashboards`, 'k-auto')).json();
  assert.deepEqual(list.data, [{ id: ID.DASH2, title: 'Bintaro Monitor', stateId: null, source: 'auto' }]);

  const r = await post(`/v1/buildings/${ID.B2}/dashboards/${ID.DASH2}/embed`, {}, 'k-auto');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.entity, null, 'asset building milik tenant -> state bawaan dashboard');
  const users = tb.state.customerUsers[ID.CUST2];
  assert.equal(users.length, 1);
  assert.equal(users[0].authority, 'CUSTOMER_USER');
  assert.match(users[0].email, /^embed-c0000000@iot\.example\.com$/);
  assert.equal(tb.state.activations.length, 1);
  assert.equal(tb.state.activations[0].activateToken, `act-${users[0].id.id}`);
  const loc = new URL((await fetch(`http://127.0.0.1:${gw.address().port}${new URL(j.embedUrl).pathname}`, { redirect: 'manual' })).headers.get('location'));
  assert.equal(loc.pathname, `/dashboard/${ID.DASH2}`);
  assert.equal(loc.searchParams.get('state'), null);

  // embed kedua memakai user yang sama
  assert.equal((await post(`/v1/buildings/${ID.B2}/dashboards/${ID.DASH2}/embed`, {}, 'k-auto')).status, 200);
  assert.equal(tb.state.customerUsers[ID.CUST2].length, 1);
  assert.equal(tb.state.activations.length, 1);
});

test('SSE stream: telemetry realtime building, filter keys, unsubscribe saat client putus', async () => {
  const ac = new AbortController();
  const r = await fetch(`${base}/v1/buildings/${ID.B1}/stream?keys=current_a`, { headers: { 'X-Api-Key': 'k-full' }, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const until = async (re) => {
    while (!re.test(buf)) buf += dec.decode((await reader.read()).value);
  };
  await until(/event: ready/);
  assert.equal(hub.size, 2);

  await new Promise((res) => setTimeout(res, 5)); // tunggu FakeWS open
  const ws = FakeWS.instances.at(-1);
  const auth = ws.sent[0];
  assert.equal(auth.authCmd.token, 'tok');
  const cmdDev1 = auth.cmds.find((c) => c.entityId === ID.DEV1).cmdId;
  ws.push({ subscriptionId: cmdDev1, errorCode: 0, data: { current_a: [[99, '3.1']], mode: [[99, 'manual']] } });
  await until(/event: telemetry/);
  const data = JSON.parse(buf.split('event: telemetry\ndata: ')[1].split('\n')[0]);
  assert.deepEqual(data, { buildingId: ID.B1, deviceId: ID.DEV1, deviceName: 'Pompa A', values: { current_a: { ts: 99, value: 3.1 } } });

  ac.abort();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(hub.size, 0);
  assert.ok(ws.sent.some((m) => m.cmds?.some((c) => c.unsubscribe)));
});

test('webhook: alarm baseline lalu created/cleared, telemetry batch, signature HMAC', async () => {
  const received = [];
  const receiver = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received.push({ headers: req.headers, body });
    res.writeHead(200).end();
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const secret = 'rahasia-webhook-1234';
  const clients = validateClients({
    clients: [
      {
        id: 'hook',
        keySha256: sha('k-hook'),
        buildings: [ID.B1],
        scopes: ['read', 'webhooks'],
        webhooks: [{ id: 'ops', url: `http://127.0.0.1:${receiver.address().port}/in`, secret, events: ['alarm', 'telemetry'], telemetryKeys: ['door'] }],
      },
    ],
  });
  const hub2 = new RealtimeHub({ wsUrl: 'ws://fake', getToken: async () => 'tok', WebSocketImpl: FakeWS, log: quiet });
  const { server, webhooks } = createGatewayServer(
    { ...{ tbInternalUrl: tb.url, tbWsUrl: 'ws://fake', tbPublicUrl: 'https://x', publicBaseUrl: 'https://x', tbUsername: 'tenant@x', tbPassword: 'pw' },
      buildingAssetType: 'building', relationType: 'Contains', maxLevel: 5, cacheSec: 60, ticketTtlSec: 60, minSessionSec: 1800,
      rateLimitPerMin: 100, alarmPollSec: 3600, webhookBatchMs: 20, clients },
    { hub: hub2, log: quiet },
  );
  try {
    await webhooks.refresh();
    assert.equal(hub2.size, 2);
    await webhooks.pollAlarms(); // baseline
    assert.equal(received.length, 0);

    const prev = tb.state.alarms;
    tb.state.alarms = [{ id: { id: 'al000000-0000-0000-0000-000000000002' }, type: 'Door Forced', severity: 'CRITICAL', status: 'ACTIVE_UNACK', originator: { id: ID.DEV2 }, originatorName: 'Gerbang', createdTime: 2 }];
    await webhooks.pollAlarms();
    tb.state.alarms = prev;
    await new Promise((r) => setTimeout(r, 30));
    const alarmMsg = received.find((m) => m.headers['x-get220v-event'] === 'alarm');
    assert.ok(alarmMsg);
    const expected = `sha256=${createHmac('sha256', secret).update(`${alarmMsg.headers['x-get220v-timestamp']}.${alarmMsg.body}`).digest('hex')}`;
    assert.equal(alarmMsg.headers['x-get220v-signature'], expected);
    const payload = JSON.parse(alarmMsg.body);
    assert.deepEqual(payload.items.map((i) => i.event).sort(), ['alarm.cleared', 'alarm.created']);

    await new Promise((r) => setTimeout(r, 5));
    const ws = FakeWS.instances.at(-1);
    const cmdDoor = ws.sent[0].cmds.find((c) => c.entityId === ID.DEV2).cmdId;
    ws.push({ subscriptionId: cmdDoor, errorCode: 0, data: { door: [[5, 'closed']], rssi: [[5, '-70']] } });
    ws.push({ subscriptionId: cmdDoor, errorCode: 0, data: { door: [[6, 'open']] } });
    await new Promise((r) => setTimeout(r, 80));
    const tel = received.filter((m) => m.headers['x-get220v-event'] === 'telemetry');
    assert.equal(tel.length, 1, 'dua update dalam satu window = satu POST');
    const tp = JSON.parse(tel[0].body);
    assert.equal(tp.buildingId, ID.B1);
    assert.deepEqual(tp.items.map((i) => i.values), [{ door: { ts: 5, value: 'closed' } }, { door: { ts: 6, value: 'open' } }]);
  } finally {
    server.close();
    receiver.close();
    receiver.closeAllConnections();
  }
});

test('validasi config client', () => {
  assert.throws(() => validateClients({ clients: [{ id: 'xx', keySha256: sha('a'), buildings: ['*'], scopes: ['nope'] }] }), /scope|scopes/);
  assert.throws(
    () => validateClients({ clients: [{ id: 'xx', keySha256: sha('a'), buildings: ['*'], scopes: ['webhooks'], webhooks: [{ id: 'w', url: 'http://evil.com', secret: 'x'.repeat(16) }] }] }),
    /https/,
  );
  assert.throws(() => validateClients({ clients: [{ id: 'xx', keySha256: sha('a'), buildings: ['bukan-uuid'] }] }), /UUID/);
});

test('realtime: subscriber kedua dapat snapshot dari cache', async () => {
  const h = new RealtimeHub({ wsUrl: 'ws://fake', getToken: async () => 'tok', WebSocketImpl: FakeWS, log: quiet, staleMs: 0 });
  try {
    const a = [];
    h.subscribe(ID.DEV1, (m) => a.push(m.values));
    await new Promise((r) => setTimeout(r, 5));
    const ws = FakeWS.instances.at(-1);
    const cmdId = ws.sent[0].cmds[0].cmdId;
    ws.push({ subscriptionId: cmdId, errorCode: 0, data: { t: [[1, '20']], h: [[1, '60']] } });
    ws.push({ subscriptionId: cmdId, errorCode: 0, data: { t: [[2, '21']] } });
    const b = [];
    h.subscribe(ID.DEV1, (m) => b.push(m.values));
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(a.length, 2);
    assert.deepEqual(b, [{ t: { ts: 2, value: 21 }, h: { ts: 1, value: 60 } }]);
    assert.equal(ws.sent.length, 1, 'tidak subscribe ulang ke TB');
  } finally {
    h.close();
  }
});

test('realtime: watchdog membuka ulang koneksi yang diam', async () => {
  let t = 1000;
  let tokens = 0;
  const h = new RealtimeHub({ wsUrl: 'ws://fake', getToken: async () => `tok${++tokens}`, WebSocketImpl: FakeWS, log: quiet, staleMs: 60_000, now: () => t });
  try {
    const got = [];
    h.subscribe(ID.DEV1, (m) => got.push(m.values));
    await new Promise((r) => setTimeout(r, 5));
    const ws1 = FakeWS.instances.at(-1);
    t += 30_000;
    assert.equal(h.checkStale(), false);
    t += 31_000;
    assert.equal(h.checkStale(), true);
    await new Promise((r) => setTimeout(r, 5));
    const ws2 = FakeWS.instances.at(-1);
    assert.notEqual(ws1, ws2);
    assert.equal(ws2.sent[0].authCmd.token, 'tok2', 'token baru');
    assert.equal(ws2.sent[0].cmds[0].entityId, ID.DEV1, 'subscribe ulang');
    ws1.push({ subscriptionId: 1, errorCode: 0, data: { t: [[9, '1']] } });
    assert.equal(got.length, 0, 'pesan dari socket lama diabaikan');
    ws2.push({ subscriptionId: ws2.sent[0].cmds[0].cmdId, errorCode: 0, data: { t: [[10, '22']] } });
    assert.deepEqual(got, [{ t: { ts: 10, value: 22 } }]);
  } finally {
    h.close();
  }
});
