import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export const SCOPES = ['read', 'telemetry', 'history', 'attributes', 'alarms', 'stream', 'dashboards', 'rpc', 'webhooks'];
export const WEBHOOK_EVENTS = ['telemetry', 'alarm'];

const stripSlash = (u) => u.replace(/\/+$/, '');
const int = (v, def) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function loadDotEnv(file = resolve(ROOT, '.env')) {
  if (existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

function uuidList(where, list, { allowStar = true } = {}) {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${where} wajib (list UUID${allowStar ? ' atau ["*"]' : ''})`);
  for (const v of list) {
    if (!(allowStar && v === '*') && !UUID_RE.test(v)) throw new Error(`${where}: "${v}" bukan UUID`);
  }
  return { all: list.includes('*'), ids: new Set(list.filter((v) => v !== '*').map((v) => v.toLowerCase())) };
}

function validateWebhook(where, w) {
  if (!w || typeof w.id !== 'string' || !/^[\w-]{1,64}$/.test(w.id)) throw new Error(`${where}.id wajib`);
  let url;
  try {
    url = new URL(w.url);
  } catch {
    throw new Error(`${where}.url tidak valid`);
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${where}.url harus https (http hanya untuk localhost)`);
  }
  if (typeof w.secret !== 'string' || w.secret.length < 16) throw new Error(`${where}.secret wajib (>= 16 karakter)`);
  const events = w.events ?? WEBHOOK_EVENTS;
  for (const e of events) if (!WEBHOOK_EVENTS.includes(e)) throw new Error(`${where}.events: "${e}" tidak dikenal`);
  const telemetryKeys = w.telemetryKeys ?? null;
  if (telemetryKeys !== null && !Array.isArray(telemetryKeys)) throw new Error(`${where}.telemetryKeys harus array`);
  return {
    id: w.id,
    url: url.toString(),
    secret: w.secret,
    buildings: uuidList(`${where}.buildings`, w.buildings ?? ['*']),
    events: new Set(events),
    telemetryKeys: telemetryKeys && new Set(telemetryKeys),
  };
}

export function validateClients(raw) {
  const list = Array.isArray(raw) ? raw : raw?.clients;
  if (!Array.isArray(list) || list.length === 0) throw new Error('clients file: harus berisi { "clients": [ ... ] }');
  const ids = new Set();
  return list.map((c, i) => {
    const where = `clients[${i}]`;
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(c.id)) throw new Error(`${where}.id wajib`);
    if (ids.has(c.id)) throw new Error(`${where}.id duplikat: ${c.id}`);
    ids.add(c.id);
    if (typeof c.keySha256 !== 'string' || !SHA256_RE.test(c.keySha256)) {
      throw new Error(`${where}.keySha256 wajib (hex sha256; pakai npm run hash-key)`);
    }
    const scopes = c.scopes ?? ['read', 'telemetry'];
    for (const s of scopes) if (!SCOPES.includes(s)) throw new Error(`${where}.scopes: "${s}" tidak dikenal (${SCOPES.join(', ')})`);
    if (scopes.includes('dashboards') && c.embedUserId !== undefined && !UUID_RE.test(c.embedUserId)) {
      throw new Error(`${where}.embedUserId harus UUID user TB`);
    }
    if (c.rpcMethods !== undefined && !Array.isArray(c.rpcMethods)) throw new Error(`${where}.rpcMethods harus array`);
    const webhooks = (c.webhooks ?? []).map((w, j) => validateWebhook(`${where}.webhooks[${j}]`, w));
    if (webhooks.length && !scopes.includes('webhooks')) throw new Error(`${where}: webhooks butuh scope "webhooks"`);
    return {
      id: c.id,
      name: c.name ?? c.id,
      keySha256: c.keySha256.toLowerCase(),
      buildings: uuidList(`${where}.buildings`, c.buildings),
      scopes: new Set(scopes),
      rpcMethods: c.rpcMethods ? new Set(c.rpcMethods) : null,
      embedUserId: c.embedUserId ? c.embedUserId.toLowerCase() : null,
      includeRefreshToken: Boolean(c.includeRefreshToken),
      allowedOrigins: (c.allowedOrigins ?? []).map(stripSlash),
      maxStreams: int(c.maxStreams, 5),
      webhooks,
    };
  });
}

export function loadConfig(env = process.env) {
  const file = resolve(ROOT, env.CLIENTS_FILE || 'clients.json');
  if (!existsSync(file)) throw new Error(`CLIENTS_FILE tidak ditemukan: ${file} (salin dari clients.example.json)`);
  const clients = validateClients(JSON.parse(readFileSync(file, 'utf8')));
  if (!env.TB_TENANT_USERNAME || !env.TB_TENANT_PASSWORD) {
    throw new Error('TB_TENANT_USERNAME dan TB_TENANT_PASSWORD wajib (di .env, jangan di-commit)');
  }
  const tbPublicUrl = stripSlash(env.TB_PUBLIC_URL || 'https://iot.get220v.com');
  const tbInternalUrl = stripSlash(env.TB_INTERNAL_URL || 'http://localhost:8080');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3011),
    tbInternalUrl,
    tbWsUrl: stripSlash(env.TB_WS_URL || tbInternalUrl.replace(/^http/, 'ws')) + '/api/ws',
    tbPublicUrl,
    publicBaseUrl: stripSlash(env.PUBLIC_BASE_URL || `${tbPublicUrl}/building-api`),
    tbUsername: env.TB_TENANT_USERNAME,
    tbPassword: env.TB_TENANT_PASSWORD,
    buildingAssetType: env.BUILDING_ASSET_TYPE || 'building',
    relationType: env.BUILDING_RELATION_TYPE || 'Contains',
    maxLevel: int(env.BUILDING_MAX_LEVEL, 5),
    cacheSec: int(env.TOPOLOGY_CACHE_SEC, 60),
    ticketTtlSec: int(env.TICKET_TTL_SEC, 60),
    minSessionSec: int(env.MIN_SESSION_SEC, 1800),
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 300),
    alarmPollSec: int(env.ALARM_POLL_SEC, 30),
    clientCacheSec: int(env.CLIENT_CACHE_SEC, 30),
    realtimeStaleSec: int(env.REALTIME_STALE_SEC, 300),
    webhookBatchMs: int(env.WEBHOOK_BATCH_MS, 5000),
    clients,
  };
}
