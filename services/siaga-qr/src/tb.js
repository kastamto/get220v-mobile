/**
 * Akses ThingsBoard SELALU memakai JWT user yang memanggil: ThingsBoard sendiri yang
 * menegakkan tenant/customer scope. Service ini tidak punya kredensial ThingsBoard.
 */
import { createHash } from 'node:crypto';

const NULL_UUID = '13814000-1dd2-11b2-8080-808080808080';
const idOf = (ref) => (ref?.id && ref.id !== NULL_UUID ? String(ref.id).toLowerCase() : null);

export class TbError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jwtExpMs(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class Tb {
  constructor({ baseUrl, fetchImpl = fetch, now = Date.now, authCacheSec = 30 }) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.authCacheMs = authCacheSec * 1000;
    this.authCache = new Map(); // sha256(token) -> { user, exp }
  }

  async #get(token, path) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        headers: { Accept: 'application/json', 'X-Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new TbError(502, `ThingsBoard tidak bisa dihubungi: ${e.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new TbError(res.status, `ThingsBoard ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  /**
   * Validasi JWT ke ThingsBoard (/api/auth/user) -> identitas tepercaya.
   * Cache singkat per token, tidak melewati exp token.
   */
  async authenticate(token) {
    const key = createHash('sha256').update(token).digest('hex');
    const c = this.authCache.get(key);
    const t = this.now();
    if (c && c.exp > t) return c.user;
    const u = await this.#get(token, '/api/auth/user').catch((e) => {
      if (e.status === 401 || e.status === 403) return null;
      throw e;
    });
    if (!u?.id?.id) return null;
    const user = {
      userId: String(u.id.id).toLowerCase(),
      authority: u.authority,
      tenantId: idOf(u.tenantId),
      customerId: idOf(u.customerId),
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || null,
      email: u.email ?? null,
    };
    const exp = Math.min(t + this.authCacheMs, jwtExpMs(token) ?? t + this.authCacheMs);
    if (this.authCache.size > 5000) this.authCache.clear();
    this.authCache.set(key, { user, exp });
    return user;
  }

  /** Device yang boleh dilihat user ini, atau null (403/404 dari ThingsBoard). */
  async device(token, deviceId) {
    let d;
    try {
      d = await this.#get(token, `/api/device/${deviceId}`);
    } catch (e) {
      if ([400, 403, 404].includes(e.status)) return null;
      throw e;
    }
    if (!d?.id?.id) return null;
    let siteId = null;
    try {
      const attrs = await this.#get(token, `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SERVER_SCOPE?keys=siteId,building`);
      const pick = (k) => attrs?.find((a) => a.key === k)?.value;
      siteId = pick('siteId') ?? pick('building') ?? null;
      if (siteId != null) siteId = String(siteId).slice(0, 128);
    } catch {
      /* siteId hanya informasi */
    }
    return {
      deviceId: String(d.id.id).toLowerCase(),
      name: d.name ?? null,
      tenantId: idOf(d.tenantId),
      customerId: idOf(d.customerId),
      siteId,
    };
  }

  /** Semua device tenant (untuk batch allTenantDevices); butuh token TENANT_ADMIN. */
  async tenantDeviceIds(token) {
    const out = [];
    for (let page = 0; page < 1000; page++) {
      const r = await this.#get(token, `/api/tenant/devices?pageSize=100&page=${page}&sortProperty=name&sortOrder=ASC`);
      for (const d of r?.data ?? []) out.push(String(d.id.id).toLowerCase());
      if (!r?.hasNext) break;
    }
    return out;
  }
}
