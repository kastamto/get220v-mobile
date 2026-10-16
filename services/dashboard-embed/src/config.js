import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export { UUID_RE };

function stripSlash(url) {
  return url.replace(/\/+$/, '');
}

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, def) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Load `.env` di root service bila ada (tanpa dependency). Env yang sudah diset tetap menang. */
export function loadDotEnv(file = resolve(ROOT, '.env')) {
  if (existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  }
}

export function validateApps(raw) {
  const list = Array.isArray(raw) ? raw : raw?.apps;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('apps file: harus berisi { "apps": [ ... ] } dengan minimal 1 app');
  }
  const ids = new Set();
  return list.map((a, i) => {
    const where = `apps[${i}]`;
    if (!a || typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(a.id)) {
      throw new Error(`${where}.id wajib (alfanumerik, - atau _)`);
    }
    if (ids.has(a.id)) throw new Error(`${where}.id duplikat: ${a.id}`);
    ids.add(a.id);
    if (typeof a.keySha256 !== 'string' || !SHA256_RE.test(a.keySha256)) {
      throw new Error(`${where}.keySha256 wajib (hex sha256 dari API key; pakai npm run hash-key)`);
    }
    const mode = a.mode ?? 'user';
    if (!['user', 'public'].includes(mode)) {
      throw new Error(`${where}.mode harus "user" atau "public"`);
    }
    if (mode === 'user' && !UUID_RE.test(a.tbUserId ?? '')) {
      throw new Error(`${where}.tbUserId wajib (UUID user TB) untuk mode "user"`);
    }
    const allowed = a.allowedDashboards ?? [];
    if (!Array.isArray(allowed) || allowed.length === 0) {
      throw new Error(`${where}.allowedDashboards wajib (list UUID dashboard, atau ["*"])`);
    }
    for (const d of allowed) {
      if (d !== '*' && !UUID_RE.test(d)) throw new Error(`${where}.allowedDashboards: "${d}" bukan UUID`);
    }
    const origins = a.allowedOrigins ?? [];
    if (!Array.isArray(origins)) throw new Error(`${where}.allowedOrigins harus array`);
    return {
      id: a.id,
      name: a.name ?? a.id,
      keySha256: a.keySha256.toLowerCase(),
      mode,
      tbUserId: mode === 'user' ? a.tbUserId.toLowerCase() : null,
      allowAll: allowed.includes('*'),
      allowedDashboards: new Set(allowed.filter((d) => d !== '*').map((d) => d.toLowerCase())),
      allowedOrigins: origins.map(stripSlash),
      includeRefreshToken: Boolean(a.includeRefreshToken),
      defaultParams: a.defaultParams && typeof a.defaultParams === 'object' ? a.defaultParams : {},
    };
  });
}

export function loadConfig(env = process.env) {
  const appsFile = resolve(ROOT, env.APPS_FILE || 'apps.json');
  if (!existsSync(appsFile)) {
    throw new Error(`APPS_FILE tidak ditemukan: ${appsFile} (salin dari apps.example.json)`);
  }
  const apps = validateApps(JSON.parse(readFileSync(appsFile, 'utf8')));

  // Akun tenant admin dipakai server-side untuk minta token user embed & cek dashboard publik
  const tbUsername = env.TB_TENANT_USERNAME;
  const tbPassword = env.TB_TENANT_PASSWORD;
  if (!tbUsername || !tbPassword) {
    throw new Error('TB_TENANT_USERNAME dan TB_TENANT_PASSWORD wajib diset (di .env, jangan di-commit)');
  }

  const tbPublicUrl = stripSlash(env.TB_PUBLIC_URL || 'https://iot.get220v.com');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3010),
    tbInternalUrl: stripSlash(env.TB_INTERNAL_URL || 'http://localhost:8080'),
    tbPublicUrl,
    publicBaseUrl: stripSlash(env.PUBLIC_BASE_URL || `${tbPublicUrl}/dash-embed`),
    tbUsername,
    tbPassword,
    ticketTtlSec: int(env.TICKET_TTL_SEC, 60),
    // token user dianggap "basi" bila sisa umurnya < ini; minta token baru
    minSessionSec: int(env.MIN_SESSION_SEC, 1800),
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 120),
    apps,
  };
}
