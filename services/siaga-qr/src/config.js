import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const BASE_PATH = '/api/siaga/v1';

const stripSlash = (u) => u.replace(/\/+$/, '');
const int = (v, def, { min = 1 } = {}) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

export function loadDotEnv(file = resolve(ROOT, '.env')) {
  if (existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

export function loadConfig(env = process.env) {
  const activeKid = env.SIAGA_QR_ACTIVE_KID || '';
  if (!KID_RE.test(activeKid)) throw new Error('SIAGA_QR_ACTIVE_KID wajib (mis. siaga-qr-2026-01)');
  const req = (k) => {
    if (!env[k]) throw new Error(`${k} wajib`);
    return env[k];
  };
  const defaultValidDays = int(env.SIAGA_QR_DEFAULT_VALID_DAYS, 1825);
  const maxValidDays = int(env.SIAGA_QR_MAX_VALID_DAYS, 3650);
  if (defaultValidDays > maxValidDays) throw new Error('SIAGA_QR_DEFAULT_VALID_DAYS > SIAGA_QR_MAX_VALID_DAYS');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3021),
    tbInternalUrl: stripSlash(env.TB_INTERNAL_URL || 'http://localhost:8080'),
    dbPath: env.SIAGA_QR_DB_PATH || resolve(ROOT, 'data/siaga-qr.db'),
    activeKid,
    signingKeyFile: req('SIAGA_QR_SIGNING_KEY_FILE'),
    publicKeysDir: req('SIAGA_QR_PUBLIC_KEYS_DIR'),
    dataKeyFile: req('SIAGA_QR_DATA_KEY_FILE'),
    defaultValidDays,
    maxValidDays,
    clockSkewSec: int(env.SIAGA_QR_CLOCK_SKEW_SEC, 300),
    syncBatchMax: int(env.SIAGA_QR_SYNC_BATCH_MAX, 100),
    maxBodyBytes: int(env.SIAGA_QR_MAX_BODY_BYTES, 16_384),
    rateLimitPerMin: int(env.SIAGA_QR_RATE_LIMIT_PER_MIN, 120),
    verifyRateLimitPerMin: int(env.SIAGA_QR_VERIFY_RATE_LIMIT_PER_MIN, 60),
    ipRateLimitPerMin: int(env.SIAGA_QR_IP_RATE_LIMIT_PER_MIN, 600),
    authCacheSec: int(env.SIAGA_QR_AUTH_CACHE_SEC, 30),
    exportTtlSec: int(env.SIAGA_QR_EXPORT_TTL_SEC, 300),
    corsOrigins: (env.SIAGA_QR_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.SIAGA_QR_TRUST_PROXY !== '0',
  };
}
