import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_PATH } from './config.js';
import { Tb, TbError } from './tb.js';
import { QrService, ApiError } from './service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = '([0-9a-fA-F-]{36})';

/** Counter & histogram sederhana, format Prometheus. Tidak pernah memuat QR/JWT. */
export class Metrics {
  constructor() {
    this.counters = new Map();
  }
  inc(name, labels = {}, by = 1) {
    const k = `${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([a, b]) => `${a}="${b}"`).join(',')}}` : ''}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  render(extra = []) {
    return [...[...this.counters.entries()].map(([k, v]) => `${k} ${v}`), ...extra].join('\n') + '\n';
  }
}

export function createQrServer(config, deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const metrics = deps.metrics ?? new Metrics();
  const tb = deps.tb ?? new Tb({ baseUrl: config.tbInternalUrl, fetchImpl: deps.fetchImpl, now, authCacheSec: config.authCacheSec });
  const service = new QrService({ db: deps.db, keys: deps.keys, tb, config, now, log, metrics });
  const openapi = readFileSync(resolve(ROOT, 'openapi.yaml'), 'utf8');
  const buckets = new Map(); // key -> { n, reset }

  const limited = (key, perMin) => {
    const t = now();
    let b = buckets.get(key);
    if (!b || b.reset <= t) {
      b = { n: 0, reset: t + 60_000 };
      buckets.set(key, b);
      if (buckets.size > 20_000) for (const [k, v] of buckets) if (v.reset <= t) buckets.delete(k);
    }
    return ++b.n > perMin;
  };

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? null;
  };

  const cors = (req) => {
    const o = req.headers.origin;
    if (!o || !config.corsOrigins.includes(o)) return {};
    return {
      'Access-Control-Allow-Origin': o,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'X-Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-App-Version',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    };
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };

  async function readJson(req) {
    if (req.method !== 'POST') return {};
    const ct = String(req.headers['content-type'] ?? '');
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > config.maxBodyBytes) throw new ApiError(413, 'too_large', 'body terlalu besar');
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > config.maxBodyBytes) throw new ApiError(413, 'too_large', 'body terlalu besar');
      chunks.push(c);
    }
    if (size === 0) return {};
    if (!ct.startsWith('application/json')) throw new ApiError(415, 'unsupported_media_type', 'Content-Type harus application/json');
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bukan objek');
      return v;
    } catch {
      throw new ApiError(400, 'bad_json', 'JSON tidak valid');
    }
  }

  async function authenticate(req) {
    const h = req.headers['x-authorization'] ?? req.headers.authorization;
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,8192})$/.exec(String(h ?? ''));
    if (!m) throw new ApiError(401, 'unauthorized', 'X-Authorization: Bearer <jwt> wajib');
    const user = await tb.authenticate(m[1]);
    if (!user) throw new ApiError(401, 'unauthorized', 'token tidak valid atau kedaluwarsa');
    return { user, token: m[1] };
  }

  // [method, regex, handler(ctx, match, body, url), isVerify]
  const routes = [
    ['POST', /^\/qr\/generate$/, (c, _m, b) => service.generate(c, b)],
    ['POST', /^\/qr\/verify$/, (c, _m, b) => service.verify(c, b), true],
    ['GET', /^\/qr\/labels$/, (c, _m, _b, u) => service.list(c, u.searchParams)],
    ['POST', new RegExp(`^/qr/labels/${UUID}/revoke$`), (c, m, b) => service.revoke(c, m[1], b)],
    ['POST', new RegExp(`^/qr/labels/${UUID}/reissue$`), (c, m, b) => service.reissue(c, m[1], b)],
    ['POST', /^\/qr\/generate-batch$/, (c, _m, b) => service.generateBatch(c, b)],
    ['GET', /^\/qr\/jobs\/(qrjob-[0-9a-fA-F-]{36})$/, (c, m) => service.job(c, m[1])],
    ['POST', /^\/qr\/export$/, (c, _m, b) => service.createExport(c, b)],
  ];

  const server = createServer(async (req, res) => {
    const started = now();
    const reqId = /^[\w.-]{1,64}$/.test(String(req.headers['x-request-id'] ?? '')) ? String(req.headers['x-request-id']) : randomUUID();
    res.setHeader('X-Request-Id', reqId);
    const url = new URL(req.url, 'http://x');
    let route = 'unknown';
    let userId = null;
    res.on('finish', () => {
      metrics.inc('siaga_qr_http_requests_total', { route, status: res.statusCode });
      metrics.inc('siaga_qr_http_duration_ms_sum', { route }, now() - started);
      // log terstruktur: tanpa header Authorization, body, atau nilai QR
      log.log?.(JSON.stringify({ ts: new Date(started).toISOString(), level: 'info', reqId, method: req.method, route, status: res.statusCode, ms: now() - started, userId }));
    });

    try {
      // endpoint internal (tidak diteruskan nginx): metrics untuk monitoring lokal
      if (url.pathname === '/metrics' && req.method === 'GET') {
        route = 'metrics';
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return res.end(metrics.render([`siaga_qr_active_key_info{kid="${deps.keys.activeKid}"} 1`, `siaga_qr_jobs_running ${service.runningJobs.size}`]));
      }
      if (!url.pathname.startsWith(BASE_PATH)) {
        route = 'not_found';
        return send(res, 404, { error: 'not_found' });
      }
      const path = url.pathname.slice(BASE_PATH.length) || '/';
      if (req.method === 'OPTIONS') {
        route = 'preflight';
        res.writeHead(204, cors(req));
        return res.end();
      }
      if (path === '/health' && req.method === 'GET') {
        route = 'health';
        return send(res, 200, { ok: true });
      }
      if (path === '/ready' && req.method === 'GET') {
        route = 'ready';
        try {
          deps.db.prepare('SELECT 1').get();
          return send(res, 200, { ok: true, kid: deps.keys.activeKid });
        } catch {
          return send(res, 503, { ok: false });
        }
      }
      if (path === '/openapi.yaml' && req.method === 'GET') {
        route = 'openapi';
        res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' });
        return res.end(openapi);
      }
      const ip = clientIp(req);
      if (limited(`ip:${ip}`, config.ipRateLimitPerMin)) throw new ApiError(429, 'rate_limited', 'terlalu banyak request');

      const exportMatch = /^\/qr\/export\/([A-Za-z0-9_-]{32})$/.exec(path);
      let found = null;
      let match = null;
      if (!exportMatch) {
        for (const r of routes) {
          if (r[0] !== req.method) continue;
          const m = r[1].exec(path);
          if (m) {
            found = r;
            match = m;
            break;
          }
        }
        if (!found) {
          route = 'not_found';
          throw new ApiError(404, 'not_found', 'endpoint tidak ada');
        }
      }
      route = exportMatch ? 'export_download' : found[1].source.replace(/\\\//g, '/').replace(/[\^$]/g, '').replace(UUID, '{id}');

      const body = await readJson(req);
      const { user, token } = await authenticate(req);
      userId = user.userId;
      const isVerify = Boolean(found?.[3]);
      if (limited(`u:${user.userId}`, config.rateLimitPerMin)) throw new ApiError(429, 'rate_limited', 'terlalu banyak request');
      if (isVerify && limited(`v:${user.userId}`, config.verifyRateLimitPerMin)) throw new ApiError(429, 'rate_limited', 'terlalu banyak verifikasi');
      if (limited(`t:${user.tenantId}`, config.rateLimitPerMin * 20)) throw new ApiError(429, 'rate_limited', 'terlalu banyak request tenant');

      const ctx = {
        user,
        token,
        reqId,
        ip,
        userAgent: req.headers['user-agent'],
        appVersion: req.headers['x-app-version'],
        idempotencyKey: req.headers['idempotency-key'],
      };
      if (exportMatch) {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET');
        const out = service.consumeExport(ctx, exportMatch[1]);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${out.filename}"`,
          'Cache-Control': 'no-store',
          ...cors(req),
        });
        return res.end(out.csv);
      }
      const r = await found[2](ctx, match, body, url);
      return send(res, r.status, r.body, cors(req));
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra }, cors(req));
      if (e instanceof TbError) return send(res, 502, { error: 'upstream', message: 'server IoT tidak bisa dihubungi' }, cors(req));
      log.error?.(JSON.stringify({ level: 'error', reqId, route, err: e.message }));
      return send(res, 500, { error: 'internal', message: 'kesalahan server', requestId: reqId }, cors(req));
    }
  });

  return { server, service, metrics, tb };
}
