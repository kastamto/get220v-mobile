/**
 * Client minimal ThingsBoard REST API (CE 4.x).
 *
 * - Tenant admin login sekali, token di-cache & di-refresh otomatis (tidak pernah keluar dari server).
 * - Token user embed diminta via GET /api/user/{userId}/token (fitur TB untuk tenant admin),
 *   sehingga app lain hanya pernah memegang token user read-only, bukan kredensial admin.
 */

export class TbError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function decodeJwt(token) {
  const part = token.split('.')[1];
  if (!part) throw new Error('JWT tidak valid');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export const NULL_UUID = '13814000-1dd2-11b2-8080-808080808080';

export class TbClient {
  constructor({ baseUrl, username, password, minSessionSec = 1800, fetchImpl = fetch, now = Date.now }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.minSessionSec = minSessionSec;
    this.fetch = fetchImpl;
    this.now = now;
    this.tenant = null; // { token, refreshToken, exp }
    this.tenantPending = null;
    this.userTokens = new Map(); // userId -> { token, refreshToken, exp, payload }
    this.userPending = new Map();
  }

  #expOf(token) {
    return decodeJwt(token).exp * 1000;
  }

  async #raw(method, path, { token, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new TbError(502, `ThingsBoard tidak bisa dihubungi: ${e.message}`);
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && data.message) || `HTTP ${res.status}`;
      throw new TbError(res.status, `TB ${method} ${path}: ${msg}`);
    }
    return data;
  }

  async #loginTenant() {
    // coba refresh dulu bila punya refreshToken, fallback ke login penuh
    if (this.tenant?.refreshToken) {
      try {
        const r = await this.#raw('POST', '/api/auth/token', { body: { refreshToken: this.tenant.refreshToken } });
        this.tenant = { ...r, exp: this.#expOf(r.token) };
        return this.tenant;
      } catch {
        /* lanjut login penuh */
      }
    }
    const r = await this.#raw('POST', '/api/auth/login', {
      body: { username: this.username, password: this.password },
    });
    this.tenant = { ...r, exp: this.#expOf(r.token) };
    return this.tenant;
  }

  async tenantToken({ force = false } = {}) {
    if (!force && this.tenant && this.tenant.exp - this.now() > 60_000) return this.tenant.token;
    if (force) this.tenant = this.tenant ? { ...this.tenant, exp: 0 } : null;
    this.tenantPending ??= this.#loginTenant().finally(() => {
      this.tenantPending = null;
    });
    return (await this.tenantPending).token;
  }

  /** Request sebagai tenant admin; auto re-login sekali bila 401. */
  async asTenant(method, path, body) {
    try {
      return await this.#raw(method, path, { token: await this.tenantToken(), body });
    } catch (e) {
      if (e.status !== 401) throw e;
      return this.#raw(method, path, { token: await this.tenantToken({ force: true }), body });
    }
  }

  /** Request sebagai user embed tertentu (TB yang menegakkan hak akses). */
  async asUser(userId, method, path) {
    const t = await this.userToken(userId);
    try {
      return await this.#raw(method, path, { token: t.token });
    } catch (e) {
      if (e.status !== 401) throw e;
      this.userTokens.delete(userId);
      return this.#raw(method, path, { token: (await this.userToken(userId)).token });
    }
  }

  async userToken(userId) {
    const cached = this.userTokens.get(userId);
    if (cached && cached.exp - this.now() > this.minSessionSec * 1000) return cached;
    if (!this.userPending.has(userId)) {
      const p = this.asTenant('GET', `/api/user/${userId}/token`)
        .then((r) => {
          const payload = decodeJwt(r.token);
          const entry = { token: r.token, refreshToken: r.refreshToken, exp: payload.exp * 1000, payload };
          this.userTokens.set(userId, entry);
          return entry;
        })
        .finally(() => this.userPending.delete(userId));
      this.userPending.set(userId, p);
    }
    return this.userPending.get(userId);
  }

  /** Info user pemilik token (TB yang memvalidasi tanda tangan & masa berlakunya). */
  async userOf(token) {
    return this.#raw('GET', '/api/auth/user', { token });
  }

  /** tenantId akun service (dari token tenant admin-nya). */
  async tenantId() {
    return decodeJwt(await this.tenantToken()).tenantId ?? null;
  }

  /** customerId user bila customer user, null bila tenant-level. */
  static customerIdOf(payload) {
    const cid = payload.customerId;
    return cid && cid !== NULL_UUID ? cid : null;
  }
}
