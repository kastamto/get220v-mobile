import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../src/server.js';
import { validateClients } from '../src/config.js';
import { startMockTb } from './mockTb.js';

let tb, gw, base;
before(async () => {
  tb = await startMockTb();
  ({ server: gw } = createGatewayServer(
    {
      tbInternalUrl: tb.url, tbWsUrl: 'ws://fake', tbPublicUrl: 'https://iot.example.com', publicBaseUrl: 'https://iot.example.com/building-api',
      tbUsername: 'tenant@x', tbPassword: 'pw', buildingAssetType: 'building', relationType: 'Contains', maxLevel: 5, cacheSec: 60,
      ticketTtlSec: 60, minSessionSec: 1800, rateLimitPerMin: 100, alarmPollSec: 3600, webhookBatchMs: 20,
      clients: validateClients({ clients: [{ id: 'xx', keySha256: '0'.repeat(64), buildings: ['*'] }] }),
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

test('playground: HTML tanpa auth, CSP ketat, tidak bisa di-frame, tanpa rahasia', async () => {
  const r = await fetch(`${base}/playground`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src 'self' https:\/\/iot\.example\.com/);
  const html = await r.text();
  assert.match(html, /Building API Playground/);
  assert.doesNotMatch(html, /<script[^>]+src=/, 'tidak boleh memuat script eksternal');
  assert.equal((await fetch(`${base}/playground/`)).status, 200);
});
