import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TbClient, TbError } from './tbClient.js';
import { Gateway, ApiError, parseKeys } from './gateway.js';
import { RealtimeHub } from './realtime.js';
import { WebhookDispatcher } from './webhooks.js';
import { UUID_RE } from './config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 16 * 1024;
const PREFIX = /^\/building-api(?=\/)/;

function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new ApiError(413, 'body terlalu besar');
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ApiError(400, 'body harus JSON object');
  }
}

/** Encode state dashboard TB (sama dengan objToBase64URI di frontend TB). */
export function encodeTbState(states) {
  return Buffer.from(JSON.stringify(states), 'utf8').toString('base64');
}

export function createGatewayServer(config, deps = {}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const tb =
    deps.tb ??
    new TbClient({ baseUrl: config.tbInternalUrl, username: config.tbUsername, password: config.tbPassword, minSessionSec: config.minSessionSec });
  const gateway = new Gateway({ tb, config, now });
  const hub = deps.hub ?? new RealtimeHub({ wsUrl: config.tbWsUrl, getToken: () => tb.tenantToken(), WebSocketImpl: deps.WebSocketImpl, log });
  const webhooks = new WebhookDispatcher({ gateway, hub, clients: config.clients, config, fetchImpl: deps.webhookFetch, log, now });

  const clients = config.clients.map((c) => ({ ...c, keyHash: Buffer.from(c.keySha256, 'hex') }));
  const allOrigins = new Set(clients.flatMap((c) => c.allowedOrigins));
  const rate = new Map();
  const streams = new Map(); // clientId -> count
  const tickets = new Map();
  let openapi = null;

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
  }, 30_000);
  sweep.unref();

  function authenticate(req) {
    const key = req.headers['x-api-key'] || (req.headers.authorization ?? '').replace(/^(ApiKey|Bearer)\s+/i, '');
    if (!key) throw new ApiError(401, 'API key wajib (header X-Api-Key)');
    const h = createHash('sha256').update(String(key)).digest();
    let found = null;
    for (const c of clients) if (timingSafeEqual(h, c.keyHash)) found = c;
    if (!found) throw new ApiError(401, 'API key tidak valid');
    const t = now();
    const r = rate.get(found.id);
    if (!r || t - r.start >= 60_000) rate.set(found.id, { start: t, count: 1 });
    else if (++r.count > config.rateLimitPerMin) throw new ApiError(429, 'terlalu banyak request');
    return found;
  }

  function need(client, scope) {
    if (!client.scopes.has(scope)) throw new ApiError(403, `client tidak punya scope "${scope}"`);
  }

  function cors(req, client) {
    const origin = (req.headers.origin ?? '').replace(/\/+$/, '');
    if (!origin) return {};
    const ok = client ? client.allowedOrigins.includes(origin) : allOrigins.has(origin);
    if (!ok) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'X-Api-Key, Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    };
  }

  // ---------- dashboard embed (link sekali pakai) ----------

  async function embed(client, buildingId, dashboardId, body) {
    if (!client.embedUserId) throw new ApiError(400, 'client belum punya embedUserId (user TB read-only untuk embed)');
    const list = await gateway.dashboards(client, buildingId);
    const dash = list.find((d) => d.id === dashboardId);
    if (!dash) throw new ApiError(404, 'dashboard tidak terdaftar untuk building ini');

    let entity = { id: buildingId, entityType: 'ASSET' };
    let entityName = (await gateway.topology(buildingId)).building.name;
    if (body.deviceId !== undefined) {
      const did = String(body.deviceId).toLowerCase();
      const { device } = await gateway.requireDevice(client, buildingId, did);
      entity = { id: did, entityType: 'DEVICE' };
      entityName = device.name;
    }
    // pastikan user embed memang bisa membuka dashboard & entity-nya (permission TB)
    try {
      await tb.asUser(client.embedUserId, 'GET', `/api/dashboard/info/${dashboardId}`);
      await tb.asUser(client.embedUserId, 'GET', entity.entityType === 'ASSET' ? `/api/asset/${entity.id}` : `/api/device/${entity.id}`);
    } catch (e) {
      if (e instanceof TbError && [403, 404].includes(e.status)) {
        throw new ApiError(403, 'user embed belum di-assign ke dashboard / building ini di TB');
      }
      throw e;
    }
    const stateId = typeof body.stateId === 'string' && /^[\w-]{1,64}$/.test(body.stateId) ? body.stateId : dash.stateId ?? 'default';
    const t = await tb.userToken(client.embedUserId);
    const qs = new URLSearchParams({ accessToken: t.token });
    if (client.includeRefreshToken) qs.set('refreshToken', t.refreshToken);
    qs.set('state', encodeTbState([{ id: stateId, params: { entityId: entity, entityName } }]));
    if (body.hideToolbar !== false) qs.set('hideToolbar', 'true');

    const ticket = randomBytes(24).toString('base64url');
    const exp = now() + config.ticketTtlSec * 1000;
    tickets.set(ticket, { url: `${config.tbPublicUrl}/dashboard/${dashboardId}?${qs}`, exp });
    return {
      embedUrl: `${config.publicBaseUrl}/e/${ticket}`,
      ticketExpiresAt: new Date(exp).toISOString(),
      sessionExpiresAt: client.includeRefreshToken ? null : new Date(t.exp).toISOString(),
      dashboard: dash,
      entity,
    };
  }

  function consumeTicket(res, ticket) {
    const t = tickets.get(ticket);
    tickets.delete(ticket);
    if (!t || t.exp <= now()) {
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
          '<body style="font-family:sans-serif;padding:24px"><h3>Link dashboard sudah kedaluwarsa</h3>' +
          '<p>Buka ulang dari aplikasi.</p></body>',
      );
    }
    res.writeHead(302, { Location: t.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  // ---------- SSE realtime ----------

  async function stream(req, res, client, buildingId, url) {
    const topo = await gateway.requireBuilding(client, buildingId);
    const keys = new Set(parseKeys(url.searchParams.get('keys')));
    let deviceIds = [...topo.devices.keys()];
    const only = url.searchParams.get('devices');
    if (only) {
      const want = new Set(only.split(',').map((s) => s.trim().toLowerCase()));
      deviceIds = deviceIds.filter((d) => want.has(d));
    }
    const open = streams.get(client.id) ?? 0;
    if (open >= client.maxStreams) throw new ApiError(429, `maksimal ${client.maxStreams} stream bersamaan`);
    streams.set(client.id, open + 1);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: jangan buffer SSE
      ...cors(req, client),
    });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('ready', { buildingId, devices: deviceIds.length, keys: keys.size ? [...keys] : 'all' });

    const unsubs = deviceIds.map((did) =>
      hub.subscribe(did, ({ deviceId, values }) => {
        let v = values;
        if (keys.size) {
          v = Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k)));
          if (Object.keys(v).length === 0) return;
        }
        write('telemetry', { buildingId, deviceId, deviceName: topo.devices.get(deviceId)?.name ?? null, values: v });
      }),
    );
    const hb = setInterval(() => res.write(': ping\n\n'), 25_000);
    const cleanup = () => {
      clearInterval(hb);
      for (const u of unsubs) u();
      streams.set(client.id, Math.max(0, (streams.get(client.id) ?? 1) - 1));
    };
    req.on('close', cleanup);
  }

  // ---------- router ----------

  const B = '([0-9a-fA-F-]{36})';
  const routes = [
    ['GET', /^\/v1\/buildings$/, 'read', (c) => gateway.listBuildings(c).then((data) => ({ data }))],
    ['GET', new RegExp(`^/v1/buildings/${B}$`), 'read', (c, [b]) => gateway.buildingDetail(c, b)],
    ['GET', new RegExp(`^/v1/buildings/${B}/devices$`), 'read', (c, [b], u) =>
      gateway.listDevices(c, b, { type: u.searchParams.get('type'), search: u.searchParams.get('search') }).then((data) => ({ data }))],
    ['GET', new RegExp(`^/v1/buildings/${B}/devices/${B}$`), 'read', (c, [b, d]) => gateway.deviceDetail(c, b, d)],
    ['GET', new RegExp(`^/v1/buildings/${B}/telemetry/latest$`), 'telemetry', (c, [b], u) =>
      gateway.buildingLatest(c, b, parseKeys(u.searchParams.get('keys'))).then((data) => ({ data }))],
    ['GET', new RegExp(`^/v1/buildings/${B}/devices/${B}/telemetry/latest$`), 'telemetry', (c, [b, d], u) =>
      gateway.latest(c, b, d, parseKeys(u.searchParams.get('keys')))],
    ['GET', new RegExp(`^/v1/buildings/${B}/devices/${B}/telemetry$`), 'history', (c, [b, d], u) =>
      gateway.history(c, b, d, Object.fromEntries(u.searchParams))],
    ['GET', new RegExp(`^/v1/buildings/${B}/devices/${B}/attributes$`), 'attributes', (c, [b, d], u) =>
      gateway.attributes(c, b, d, { scope: u.searchParams.get('scope'), keys: u.searchParams.get('keys') })],
    ['GET', new RegExp(`^/v1/buildings/${B}/alarms$`), 'alarms', (c, [b], u) =>
      gateway.alarms(c, b, Object.fromEntries(u.searchParams)).then((data) => ({ data }))],
    ['POST', new RegExp(`^/v1/buildings/${B}/devices/${B}/rpc$`), 'rpc', (c, [b, d], _u, body) => gateway.rpc(c, b, d, body)],
    ['GET', new RegExp(`^/v1/buildings/${B}/dashboards$`), 'dashboards', (c, [b]) => gateway.dashboards(c, b).then((data) => ({ data }))],
    ['POST', new RegExp(`^/v1/buildings/${B}/dashboards/${B}/embed$`), 'dashboards', (c, [b, d], _u, body) => embed(c, b, d, body)],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(PREFIX, '');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req, null));
      return res.end();
    }
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'ok', clients: clients.length, realtimeSubscriptions: hub.size, webhooks: webhooks.targets.length });
    }
    if (req.method === 'GET' && (path === '/openapi.yaml' || path === '/v1/openapi.yaml')) {
      openapi ??= readFileSync(resolve(ROOT, 'openapi.yaml'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(openapi);
    }
    const tm = path.match(/^\/e\/([A-Za-z0-9_-]{32})$/);
    if (req.method === 'GET' && tm) return consumeTicket(res, tm[1]);

    const sm = path.match(new RegExp(`^/v1/buildings/${B}/stream$`));
    if (req.method === 'GET' && sm) {
      const client = authenticate(req);
      need(client, 'stream');
      return stream(req, res, client, sm[1].toLowerCase(), url);
    }

    for (const [method, re, scope, fn] of routes) {
      const m = path.match(re);
      if (!m) continue;
      if (req.method !== method) throw new ApiError(405, 'method tidak didukung');
      const client = authenticate(req);
      need(client, scope);
      const ids = m.slice(1).map((s) => s.toLowerCase());
      for (const id of ids) if (!UUID_RE.test(id)) throw new ApiError(400, 'ID harus UUID');
      const body = method === 'POST' ? await readJson(req) : undefined;
      return send(res, 200, await fn(client, ids, url, body), cors(req, client));
    }
    throw new ApiError(404, 'not found');
  }

  const server = createServer(async (req, res) => {
    const started = now();
    res.on('finish', () => {
      const p = (req.url ?? '').split('?')[0].replace(/\/e\/[A-Za-z0-9_-]+/, '/e/***');
      log.log(`[gw] ${req.method} ${p} ${res.statusCode} ${now() - started}ms`);
    });
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : e instanceof TbError ? 502 : 500;
      if (status >= 500) log.error(`[gw] ${req.method} ${(req.url ?? '').split('?')[0]}:`, e.message);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !(e instanceof ApiError) ? 'gagal menghubungi ThingsBoard' : e.message }, cors(req, null));
      else res.end();
    }
  });
  server.on('close', () => {
    clearInterval(sweep);
    webhooks.stop();
    hub.close();
  });
  return { server, gateway, hub, webhooks, tickets };
}
