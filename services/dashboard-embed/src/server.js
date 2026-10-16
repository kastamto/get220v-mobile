import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TbClient, TbError } from './tbClient.js';
import { UUID_RE } from './config.js';

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sha256(s) {
  return createHash('sha256').update(s).digest();
}

/** Encode state dashboard TB, sama dengan objToBase64URI() di frontend TB. */
export function encodeTbState(states) {
  return Buffer.from(JSON.stringify(states), 'utf8').toString('base64');
}

export function buildState({ stateId = 'default', entity, entityName, entityLabel }) {
  const params = {};
  if (entity) {
    params.entityId = { id: entity.id, entityType: entity.entityType };
    if (entityName) params.entityName = entityName;
    if (entityLabel) params.entityLabel = entityLabel;
  }
  return encodeTbState([{ id: stateId, params }]);
}

const ENTITY_TYPES = new Set(['DEVICE', 'ASSET', 'CUSTOMER', 'ENTITY_VIEW', 'EDGE', 'USER', 'TENANT', 'DASHBOARD']);

/** Validasi & normalisasi parameter tampilan dari body request. */
export function displayParams(body, defaults) {
  const given = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const merged = { ...defaults, ...given };
  const out = new URLSearchParams();
  if (merged.hideToolbar !== undefined) out.set('hideToolbar', String(Boolean(merged.hideToolbar)));

  if (typeof merged.state === 'string' && merged.state) {
    if (merged.state.length > 4096) throw new HttpError(400, 'state terlalu panjang');
    out.set('state', merged.state);
  } else if (merged.entity || merged.stateId) {
    const e = merged.entity;
    if (e) {
      if (!UUID_RE.test(e.id ?? '') || !ENTITY_TYPES.has(e.entityType)) {
        throw new HttpError(400, 'entity harus { id: UUID, entityType: DEVICE|ASSET|... }');
      }
    }
    if (merged.stateId !== undefined && !/^[\w-]{1,64}$/.test(merged.stateId)) {
      throw new HttpError(400, 'stateId tidak valid');
    }
    out.set(
      'state',
      buildState({
        stateId: merged.stateId,
        entity: e,
        entityName: typeof merged.entityName === 'string' ? merged.entityName.slice(0, 255) : undefined,
        entityLabel: typeof merged.entityLabel === 'string' ? merged.entityLabel.slice(0, 255) : undefined,
      }),
    );
  }
  return out;
}

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body terlalu besar');
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'body harus JSON object');
  }
}

export function createApp(config, { tb, now = Date.now } = {}) {
  tb ??= new TbClient({
    baseUrl: config.tbInternalUrl,
    username: config.tbUsername,
    password: config.tbPassword,
    minSessionSec: config.minSessionSec,
  });

  const apps = config.apps.map((a) => ({ ...a, keyHash: Buffer.from(a.keySha256, 'hex') }));
  const allOrigins = new Set(apps.flatMap((a) => a.allowedOrigins));
  const tickets = new Map(); // ticket -> { url, exp, appId }
  const rate = new Map(); // appId -> { windowStart, count }

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
  }, 30_000);
  sweep.unref();

  function authenticate(req) {
    const key = req.headers['x-api-key'] || (req.headers.authorization ?? '').replace(/^ApiKey\s+/i, '');
    if (!key) throw new HttpError(401, 'API key wajib (header X-Api-Key)');
    const h = sha256(String(key));
    // bandingkan ke semua app dengan waktu konstan
    let found = null;
    for (const a of apps) if (timingSafeEqual(h, a.keyHash)) found = a;
    if (!found) throw new HttpError(401, 'API key tidak valid');

    const t = now();
    const r = rate.get(found.id);
    if (!r || t - r.windowStart >= 60_000) {
      rate.set(found.id, { windowStart: t, count: 1 });
    } else if (++r.count > config.rateLimitPerMin) {
      throw new HttpError(429, 'terlalu banyak request, coba lagi sebentar');
    }
    return found;
  }

  function corsHeaders(req, app) {
    const origin = (req.headers.origin ?? '').replace(/\/+$/, '');
    if (!origin) return {};
    const ok = app ? app.allowedOrigins.includes(origin) : allOrigins.has(origin);
    if (!ok) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'X-Api-Key, Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    };
  }

  function assertAllowed(app, dashboardId) {
    if (!UUID_RE.test(dashboardId ?? '')) throw new HttpError(400, 'dashboardId harus UUID');
    if (!app.allowAll && !app.allowedDashboards.has(dashboardId.toLowerCase())) {
      throw new HttpError(403, 'dashboard tidak diizinkan untuk app ini');
    }
  }

  function publicCustomerOf(info) {
    return (info.assignedCustomers ?? []).find((c) => c.public)?.customerId?.id ?? null;
  }

  function summarize(d) {
    return { id: d.id.id, title: d.title, createdTime: d.createdTime, image: d.image ?? null };
  }

  async function dashboardInfo(app, dashboardId) {
    try {
      if (app.mode === 'user') {
        // TB yang memutuskan apakah user embed boleh melihat dashboard ini
        return await tb.asUser(app.tbUserId, 'GET', `/api/dashboard/info/${dashboardId}`);
      }
      const info = await tb.asTenant('GET', `/api/dashboard/info/${dashboardId}`);
      if (!publicCustomerOf(info)) throw new HttpError(403, 'dashboard belum dijadikan public di TB');
      return info;
    } catch (e) {
      if (e instanceof TbError && (e.status === 403 || e.status === 404)) {
        throw new HttpError(e.status === 403 ? 403 : 404, 'dashboard tidak ditemukan / tidak bisa diakses user embed');
      }
      throw e;
    }
  }

  async function listDashboards(app, url) {
    const page = Math.max(0, Number.parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20));
    const search = (url.searchParams.get('search') ?? '').slice(0, 100);

    if (!app.allowAll) {
      const settled = await Promise.allSettled([...app.allowedDashboards].map((id) => dashboardInfo(app, id)));
      let data = settled.filter((s) => s.status === 'fulfilled').map((s) => summarize(s.value));
      if (search) data = data.filter((d) => d.title.toLowerCase().includes(search.toLowerCase()));
      data.sort((a, b) => a.title.localeCompare(b.title));
      const total = data.length;
      return {
        data: data.slice(page * pageSize, (page + 1) * pageSize),
        totalElements: total,
        totalPages: Math.ceil(total / pageSize),
        hasNext: (page + 1) * pageSize < total,
      };
    }

    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sortProperty: 'title', sortOrder: 'ASC' });
    if (search) qs.set('textSearch', search);
    let r;
    if (app.mode === 'user') {
      const { payload } = await tb.userToken(app.tbUserId);
      const cid = TbClient.customerIdOf(payload);
      const path = cid ? `/api/customer/${cid}/dashboards` : '/api/tenant/dashboards';
      r = await tb.asUser(app.tbUserId, 'GET', `${path}?${qs}`);
    } else {
      r = await tb.asTenant('GET', `/api/tenant/dashboards?${qs}`);
      // hanya dashboard public (filter per halaman; total mengikuti TB)
      r = { ...r, data: r.data.filter((d) => publicCustomerOf(d)) };
    }
    return { data: r.data.map(summarize), totalElements: r.totalElements, totalPages: r.totalPages, hasNext: r.hasNext };
  }

  async function createEmbed(app, body) {
    const dashboardId = String(body.dashboardId ?? '').toLowerCase();
    assertAllowed(app, dashboardId);
    const params = displayParams(
      {
        hideToolbar: body.hideToolbar,
        state: body.state,
        stateId: body.stateId,
        entity: body.entity,
        entityName: body.entityName,
        entityLabel: body.entityLabel,
      },
      app.defaultParams,
    );

    const info = await dashboardInfo(app, dashboardId);
    const auth = new URLSearchParams();
    let sessionExpiresAt = null;
    if (app.mode === 'user') {
      const t = await tb.userToken(app.tbUserId);
      auth.set('accessToken', t.token);
      if (app.includeRefreshToken) auth.set('refreshToken', t.refreshToken);
      sessionExpiresAt = app.includeRefreshToken ? null : new Date(t.exp).toISOString();
    } else {
      auth.set('publicId', publicCustomerOf(info));
    }
    const qs = new URLSearchParams([...auth, ...params]);
    const tbUrl = `${config.tbPublicUrl}/dashboard/${dashboardId}?${qs}`;

    const ticket = randomBytes(24).toString('base64url');
    const exp = now() + config.ticketTtlSec * 1000;
    tickets.set(ticket, { url: tbUrl, exp, appId: app.id });

    return {
      embedUrl: `${config.publicBaseUrl}/e/${ticket}`,
      ticketExpiresAt: new Date(exp).toISOString(),
      sessionExpiresAt,
      dashboard: { id: dashboardId, title: info.title },
      ...(app.mode === 'public' ? { publicUrl: tbUrl } : {}),
    };
  }

  function consumeTicket(res, ticket) {
    const t = tickets.get(ticket);
    tickets.delete(ticket); // sekali pakai
    if (!t || t.exp <= now()) {
      return sendHtml(
        res,
        410,
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
          '<title>Link kedaluwarsa</title><body style="font-family:sans-serif;padding:24px">' +
          '<h3>Link dashboard sudah kedaluwarsa</h3><p>Muat ulang dari aplikasi untuk membuka dashboard lagi.</p></body>',
      );
    }
    res.writeHead(302, {
      Location: t.url,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // dukung mount di sub-path (mis. nginx /dash-embed/ tanpa strip prefix)
    const path = url.pathname.replace(/^\/dash-embed(?=\/)/, '');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req, null));
      return res.end();
    }
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'ok', apps: apps.length, tickets: tickets.size });
    }
    const m = path.match(/^\/e\/([A-Za-z0-9_-]{32})$/);
    if (req.method === 'GET' && m) return consumeTicket(res, m[1]);

    if (path === '/api/v1/dashboards' && req.method === 'GET') {
      const app = authenticate(req);
      return send(res, 200, await listDashboards(app, url), corsHeaders(req, app));
    }
    if (path === '/api/v1/embed' && req.method === 'POST') {
      const app = authenticate(req);
      const body = await readJson(req);
      return send(res, 200, await createEmbed(app, body), corsHeaders(req, app));
    }
    throw new HttpError(404, 'not found');
  }

  const server = createServer(async (req, res) => {
    const started = now();
    try {
      await handle(req, res);
    } catch (e) {
      // error dari TB yang tidak tertangani -> 502; detailnya hanya di log server
      const outStatus = e instanceof HttpError ? e.status : e instanceof TbError ? 502 : 500;
      if (outStatus >= 500) console.error(`[embed] ${req.method} ${req.url?.split('?')[0]}:`, e.message);
      if (!res.headersSent) {
        send(res, outStatus, { error: outStatus >= 500 ? 'gagal menghubungi ThingsBoard' : e.message }, corsHeaders(req, null));
      }
    } finally {
      const p = (req.url ?? '').split('?')[0].replace(/\/e\/[A-Za-z0-9_-]+/, '/e/***');
      console.log(`[embed] ${req.method} ${p} ${res.statusCode} ${now() - started}ms`);
    }
  });
  server.on('close', () => clearInterval(sweep));
  return { server, tickets };
}
