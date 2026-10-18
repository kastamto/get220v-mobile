/**
 * Daftar client = clients.json (statis, termasuk webhook) + client yang dikelola dari ThingsBoard.
 *
 * Client TB = asset type "api-client" (nama asset "apiclient-<id>", label = nama tampilan) dengan
 * server attribute: keySha256, keyHint, buildings, scopes, rpcMethods, embedUserId, enabled.
 * API key asli tidak pernah disimpan; hanya ditampilkan sekali saat dibuat / dirotasi.
 */
import { createHash, randomBytes } from 'node:crypto';
import { validateClients, SCOPES, UUID_RE } from './config.js';
import { toValue } from './gateway.js';
import { TbError } from './tbClient.js';

export const CLIENT_ASSET_TYPE = 'api-client';
const PREFIX = 'apiclient-';
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function newKey() {
  const key = `g220v_${randomBytes(24).toString('base64url')}`;
  return { key, keySha256: createHash('sha256').update(key).digest('hex'), keyHint: key.slice(0, 10) };
}

const withHash = (c) => ({ ...c, keyHash: Buffer.from(c.keySha256, 'hex') });
const arr = (v) => {
  const x = toValue(v);
  return Array.isArray(x) ? x : [];
};

export class ClientStore {
  constructor({ tb, fileClients, ttlMs = 30_000, log = console, now = Date.now }) {
    this.tb = tb;
    this.fileClients = fileClients.map(withHash);
    this.ttlMs = ttlMs;
    this.log = log;
    this.now = now;
    this.tbClients = null; // [{client, meta}]
    this.loadedAt = 0;
    this.pending = null;
  }

  /** Semua client aktif (untuk autentikasi). Data lama tetap dipakai bila TB sedang tidak bisa dihubungi. */
  async list() {
    if (!this.tbClients || this.now() - this.loadedAt > this.ttlMs) {
      try {
        await this.refresh();
      } catch (e) {
        this.log.error('[clients] gagal memuat client dari TB:', e.message);
        this.tbClients ??= [];
        this.loadedAt = this.now(); // coba lagi setelah TTL, jangan membanjiri TB yang sedang bermasalah
      }
    }
    return [...this.fileClients, ...this.tbClients.filter((x) => x.meta.enabled).map((x) => x.client)];
  }

  invalidate() {
    this.loadedAt = 0;
  }

  async refresh() {
    this.pending ??= this.#load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async #load() {
    const assets = [];
    for (let page = 0; page < 20; page++) {
      const r = await this.tb.asTenant('GET', `/api/tenant/assets?pageSize=100&page=${page}&type=${CLIENT_ASSET_TYPE}`);
      assets.push(...r.data);
      if (!r.hasNext) break;
    }
    const out = [];
    for (const a of assets) {
      if (!a.name?.startsWith(PREFIX)) continue;
      const attrs = Object.fromEntries(
        (await this.tb.asTenant('GET', `/api/plugins/telemetry/ASSET/${a.id.id}/values/attributes/SERVER_SCOPE`)).map((x) => [x.key, x.value]),
      );
      const id = a.name.slice(PREFIX.length);
      try {
        const [client] = validateClients({
          clients: [
            {
              id,
              name: a.label || id,
              keySha256: attrs.keySha256,
              buildings: arr(attrs.buildings),
              scopes: arr(attrs.scopes),
              rpcMethods: attrs.rpcMethods ? arr(attrs.rpcMethods) : undefined,
              embedUserId: attrs.embedUserId || undefined,
            },
          ],
        });
        out.push({
          client: withHash(client),
          meta: {
            assetId: a.id.id,
            enabled: toValue(attrs.enabled) !== false,
            keyHint: attrs.keyHint ?? null,
            createdBy: attrs.createdBy ?? null,
            updatedBy: attrs.updatedBy ?? null,
            keyRotatedAt: attrs.keyRotatedAt ? Number(attrs.keyRotatedAt) : null,
            createdTime: a.createdTime,
          },
        });
      } catch (e) {
        this.log.error(`[clients] asset ${a.name} diabaikan: ${e.message}`);
      }
    }
    this.tbClients = out;
    this.loadedAt = this.now();
    return out;
  }

  // ---------- operasi admin ----------

  #validateInput(body, { creating }) {
    const out = {};
    if (creating) {
      if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw new StoreError(400, 'id wajib: huruf kecil/angka/-/_, 2-64 karakter');
      if (this.fileClients.some((c) => c.id === body.id)) throw new StoreError(409, `id "${body.id}" sudah dipakai di clients.json`);
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw new StoreError(400, 'name 1-100 karakter');
      out.name = body.name.trim();
    }
    if (body.buildings !== undefined || creating) {
      const b = body.buildings;
      if (!Array.isArray(b) || b.length === 0) throw new StoreError(400, 'buildings wajib (list UUID atau ["*"])');
      for (const x of b) if (x !== '*' && !UUID_RE.test(x)) throw new StoreError(400, `building "${x}" bukan UUID`);
      out.buildings = b.includes('*') ? ['*'] : [...new Set(b.map((x) => x.toLowerCase()))];
    }
    if (body.scopes !== undefined || creating) {
      const s = body.scopes;
      if (!Array.isArray(s) || s.length === 0) throw new StoreError(400, 'scopes wajib');
      for (const x of s) {
        if (!SCOPES.includes(x) || x === 'webhooks') throw new StoreError(400, `scope "${x}" tidak bisa dipakai di sini`);
      }
      out.scopes = [...new Set(s)];
    }
    if (body.rpcMethods !== undefined) {
      if (body.rpcMethods !== null && (!Array.isArray(body.rpcMethods) || body.rpcMethods.some((m) => !/^[\w.-]{1,64}$/.test(m)))) {
        throw new StoreError(400, 'rpcMethods harus list nama method');
      }
      out.rpcMethods = body.rpcMethods && body.rpcMethods.length ? body.rpcMethods : '';
    }
    if (body.embedUserId !== undefined) {
      if (body.embedUserId && !UUID_RE.test(body.embedUserId)) throw new StoreError(400, 'embedUserId harus UUID user TB');
      out.embedUserId = body.embedUserId ? body.embedUserId.toLowerCase() : '';
    }
    if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
    return out;
  }

  async #find(id) {
    await this.refresh();
    const x = this.tbClients.find((c) => c.client.id === id);
    if (!x) throw new StoreError(404, this.fileClients.some((c) => c.id === id) ? 'client dari clients.json hanya bisa diubah di server' : 'client tidak ditemukan');
    return x;
  }

  async #saveAttrs(assetId, attrs) {
    await this.tb.asTenant('POST', `/api/plugins/telemetry/ASSET/${assetId}/attributes/SERVER_SCOPE`, attrs);
  }

  async create(body, actor) {
    const input = this.#validateInput(body, { creating: true });
    let asset;
    try {
      asset = await this.tb.asTenant('POST', '/api/asset', { name: `${PREFIX}${body.id}`, label: input.name ?? body.id, type: CLIENT_ASSET_TYPE });
    } catch (e) {
      if (e instanceof TbError && e.status === 400) throw new StoreError(409, `id "${body.id}" sudah dipakai`);
      throw e;
    }
    const k = newKey();
    try {
      await this.#saveAttrs(asset.id.id, {
        keySha256: k.keySha256,
        keyHint: k.keyHint,
        buildings: input.buildings,
        scopes: input.scopes,
        rpcMethods: input.rpcMethods ?? '',
        embedUserId: input.embedUserId ?? '',
        enabled: input.enabled ?? true,
        createdBy: actor,
        updatedBy: actor,
        keyRotatedAt: this.now(),
      });
    } catch (e) {
      await this.tb.asTenant('DELETE', `/api/asset/${asset.id.id}`).catch(() => {});
      throw e;
    }
    this.invalidate();
    return { id: body.id, key: k.key, keyHint: k.keyHint };
  }

  async update(id, body, actor) {
    const x = await this.#find(id);
    const input = this.#validateInput(body, { creating: false });
    if (input.name !== undefined) {
      const asset = await this.tb.asTenant('GET', `/api/asset/${x.meta.assetId}`);
      await this.tb.asTenant('POST', '/api/asset', { ...asset, label: input.name });
      delete input.name;
    }
    await this.#saveAttrs(x.meta.assetId, { ...input, updatedBy: actor });
    this.invalidate();
    return { id };
  }

  async rotate(id, actor) {
    const x = await this.#find(id);
    const k = newKey();
    await this.#saveAttrs(x.meta.assetId, { keySha256: k.keySha256, keyHint: k.keyHint, keyRotatedAt: this.now(), updatedBy: actor });
    this.invalidate();
    return { id, key: k.key, keyHint: k.keyHint };
  }

  async remove(id) {
    const x = await this.#find(id);
    await this.tb.asTenant('DELETE', `/api/asset/${x.meta.assetId}`);
    this.invalidate();
    return { id, deleted: true };
  }

  /** Untuk halaman admin: tanpa hash key. */
  async adminList() {
    await this.refresh();
    const fmt = (c) => ({
      id: c.id,
      name: c.name,
      buildings: c.buildings.all ? ['*'] : [...c.buildings.ids],
      scopes: [...c.scopes],
      rpcMethods: c.rpcMethods ? [...c.rpcMethods] : [],
      embedUserId: c.embedUserId,
    });
    return [
      ...this.fileClients.map((c) => ({ ...fmt(c), source: 'file', enabled: true, webhooks: c.webhooks.length })),
      ...this.tbClients.map(({ client, meta }) => ({ ...fmt(client), source: 'thingsboard', ...meta })),
    ];
  }
}
