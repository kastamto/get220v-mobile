/**
 * Lifecycle label QR SIAGA. Semua data tepercaya (tenant, actor, kid, waktu, expiry, device)
 * di-resolve di server dari JWT + ThingsBoard; body handset hanya memilih device/label.
 */
import { randomBytes, createHash } from 'node:crypto';
import { tx, isUniqueViolation } from './db.js';
import { QrRejected, uuidv7, b64u } from './keys.js';
import { UUID_RE } from './config.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const GENERIC_INVALID = 'QR tidak valid atau tidak dapat digunakan.';
const STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED', 'REPLACED'];
const IDEM_RE = /^[\w.:-]{8,128}$/;
const DAY = 86_400_000;

const iso = (ms) => new Date(ms).toISOString();
const isAdmin = (u) => u.authority === 'TENANT_ADMIN';
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

function requireAdmin(ctx) {
  if (!isAdmin(ctx.user)) throw new ApiError(403, 'forbidden', 'hanya TENANT_ADMIN');
  if (!ctx.user.tenantId) throw new ApiError(403, 'forbidden', 'user tanpa tenant');
}

function requireUuid(v, field) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new ApiError(400, 'bad_request', `${field} harus UUID`);
  return v.toLowerCase();
}

/** Bentuk publik label (tanpa nilai QR lengkap, nonce, atau hash). */
export function publicLabel(r) {
  return {
    labelId: r.id,
    deviceId: r.device_id,
    deviceName: r.device_name_snapshot,
    siteId: r.site_id_snapshot,
    customerId: r.customer_id,
    kid: r.key_id,
    status: r.status,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    issuedBy: { userId: r.issued_by_user_id, name: r.issued_by_name },
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by_user_id,
    revokeReason: r.revoke_reason,
    replacedByLabelId: r.replaced_by_label_id,
  };
}

export class QrService {
  constructor({ db, keys, tb, config, now = Date.now, log = console, metrics }) {
    this.db = db;
    this.keys = keys;
    this.tb = tb;
    this.config = config;
    this.now = now;
    this.log = log;
    this.metrics = metrics;
    this.exports = new Map(); // token -> { tenantId, userId, labelIds, exp }
    this.runningJobs = new Set();
    this.st = {
      label: db.prepare('SELECT * FROM siaga_qr_labels WHERE tenant_id = ? AND id = ?'),
      labelAnyTenant: db.prepare('SELECT * FROM siaga_qr_labels WHERE id = ?'),
      activeForDevice: db.prepare("SELECT * FROM siaga_qr_labels WHERE tenant_id = ? AND device_id = ? AND status = 'ACTIVE'"),
      insertLabel: db.prepare(`INSERT INTO siaga_qr_labels
        (id, tenant_id, customer_id, device_id, site_id_snapshot, device_name_snapshot, key_id, payload_hash, nonce_enc,
         status, iat, exp, issued_at, expires_at, issued_by_user_id, issued_by_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)`),
      revoke: db.prepare(`UPDATE siaga_qr_labels SET status = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'ACTIVE'`),
      replace: db.prepare(`UPDATE siaga_qr_labels SET status = CASE WHEN status = 'ACTIVE' THEN 'REPLACED' ELSE status END,
        replaced_by_label_id = ?, revoked_at = COALESCE(revoked_at, ?), revoked_by_user_id = COALESCE(revoked_by_user_id, ?),
        revoke_reason = COALESCE(revoke_reason, ?), updated_at = ? WHERE tenant_id = ? AND id = ?`),
      expire: db.prepare(`UPDATE siaga_qr_labels SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at <= ? AND tenant_id = ?`),
      expireOne: db.prepare(`UPDATE siaga_qr_labels SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at <= ? AND id = ?`),
      audit: db.prepare(`INSERT INTO siaga_qr_audit
        (id, tenant_id, label_id, device_id, actor_user_id, actor_name, action, at, correlation_id, reason, source_ip_hash, user_agent, app_version, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      idemGet: db.prepare('SELECT * FROM siaga_qr_idempotency WHERE tenant_id = ? AND actor_user_id = ? AND idem_key = ?'),
      idemPut: db.prepare('INSERT INTO siaga_qr_idempotency (tenant_id, actor_user_id, idem_key, request_hash, label_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      jobInsert: db.prepare(`INSERT INTO siaga_qr_jobs (id, tenant_id, actor_user_id, status, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      jobUpdate: db.prepare(`UPDATE siaga_qr_jobs SET status = ?, processed = ?, created = ?, skipped = ?, failed = ?, items = ?, updated_at = ? WHERE id = ?`),
      jobGet: db.prepare('SELECT * FROM siaga_qr_jobs WHERE tenant_id = ? AND id = ?'),
      jobsInterrupt: db.prepare(`UPDATE siaga_qr_jobs SET status = 'INTERRUPTED', updated_at = ? WHERE status = 'RUNNING'`),
    };
    // job yang berjalan saat proses mati tidak dilanjutkan otomatis; jalankan ulang batch
    // dengan onlyWithoutActiveLabel=true (aman, tidak membuat duplikat)
    this.st.jobsInterrupt.run(iso(this.now()));
  }

  // ---------- audit ----------

  audit(ctx, { action, tenantId, labelId = null, deviceId = null, reason = null, metadata = null }) {
    this.st.audit.run(
      uuidv7(this.now()),
      tenantId ?? ctx.user.tenantId ?? 'unknown',
      labelId,
      deviceId,
      ctx.user?.userId ?? null,
      clip(ctx.user?.name, 200),
      action,
      iso(this.now()),
      clip(ctx.reqId, 64),
      clip(reason, 500),
      this.keys.hashIp(ctx.ip),
      clip(ctx.userAgent, 200),
      clip(ctx.appVersion, 64),
      metadata ? JSON.stringify(metadata) : null,
    );
  }

  // ---------- helpers ----------

  #validDays(v) {
    if (v === undefined || v === null) return this.config.defaultValidDays;
    if (!Number.isInteger(v)) throw new ApiError(400, 'bad_request', 'validForDays harus bilangan bulat');
    return Math.min(Math.max(v, 1), this.config.maxValidDays);
  }

  #idemKey(ctx) {
    const k = ctx.idempotencyKey;
    if (k === undefined || k === null || k === '') return null;
    if (!IDEM_RE.test(k)) throw new ApiError(400, 'bad_request', 'Idempotency-Key 8–128 karakter [A-Za-z0-9_.:-]');
    return k;
  }

  async #resolveAdminDevice(ctx, deviceId) {
    const d = await this.tb.device(ctx.token, deviceId);
    // ThingsBoard sudah membatasi ke tenant admin; cek ulang tenant sebagai lapis kedua
    if (!d || d.tenantId !== ctx.user.tenantId) throw new ApiError(404, 'device_not_found', 'device tidak ditemukan di tenant Anda');
    return d;
  }

  /** Bangun ulang nilai QR dari record (Ed25519 deterministik -> QR identik). */
  qrOf(row) {
    if (row.key_id !== this.keys.activeKid) return null; // private key lama tidak tersedia
    const payload = {
      v: 1,
      kid: row.key_id,
      labelId: row.id,
      deviceId: row.device_id,
      tenantId: row.tenant_id,
      iat: row.iat,
      exp: row.exp,
      nonce: this.keys.decryptNonce(row.nonce_enc, row.id),
    };
    const s = this.keys.signPayload(payload);
    if (s.payloadHash !== row.payload_hash) throw new Error(`payload_hash tidak cocok untuk label ${row.id}`);
    return s.qr;
  }

  #issueResponse(row, qr) {
    return {
      labelId: row.id,
      qr,
      deviceId: row.device_id,
      deviceName: row.device_name_snapshot,
      siteId: row.site_id_snapshot,
      kid: row.key_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      status: row.status,
    };
  }

  /**
   * Insert label baru + audit GENERATED. WAJIB dipanggil di dalam tx().
   * @returns {{row, qr}}
   */
  #insertLabelTx(ctx, device, validDays, metadata) {
    const t = this.now();
    const labelId = uuidv7(t);
    const nonce = b64u(randomBytes(16));
    const iat = Math.floor(t / 1000);
    const exp = iat + validDays * 86_400;
    const payload = { v: 1, kid: this.keys.activeKid, labelId, deviceId: device.deviceId, tenantId: ctx.user.tenantId, iat, exp, nonce };
    const signed = this.keys.signPayload(payload);
    this.st.insertLabel.run(
      labelId,
      ctx.user.tenantId,
      device.customerId,
      device.deviceId,
      device.siteId,
      clip(device.name, 256),
      this.keys.activeKid,
      signed.payloadHash,
      this.keys.encryptNonce(nonce, labelId),
      iat,
      exp,
      iso(iat * 1000),
      iso(exp * 1000),
      ctx.user.userId,
      clip(ctx.user.name, 200),
      iso(t),
      iso(t),
    );
    this.audit(ctx, { action: 'GENERATED', tenantId: ctx.user.tenantId, labelId, deviceId: device.deviceId, metadata: { kid: this.keys.activeKid, validDays, ...metadata } });
    this.metrics?.inc('siaga_qr_generated_total');
    return { row: this.st.label.get(ctx.user.tenantId, labelId), qr: signed.qr };
  }

  #idemReplay(ctx, key, requestHash) {
    if (!key) return null;
    const hit = this.st.idemGet.get(ctx.user.tenantId, ctx.user.userId, key);
    if (!hit) return null;
    if (hit.request_hash !== requestHash) throw new ApiError(422, 'idempotency_conflict', 'Idempotency-Key sudah dipakai untuk request lain');
    const row = this.st.label.get(ctx.user.tenantId, hit.label_id);
    return { status: 200, body: this.#issueResponse(row, this.qrOf(row)) };
  }

  // ---------- generate ----------

  async generate(ctx, body) {
    requireAdmin(ctx);
    const deviceId = requireUuid(body.deviceId, 'deviceId');
    const validDays = this.#validDays(body.validForDays);
    const key = this.#idemKey(ctx);
    const requestHash = createHash('sha256').update(`generate|${deviceId}|${validDays}`).digest('hex');
    const replay = this.#idemReplay(ctx, key, requestHash);
    if (replay) return replay;

    const device = await this.#resolveAdminDevice(ctx, deviceId);
    try {
      return tx(this.db, () => {
        const again = this.#idemReplay(ctx, key, requestHash); // retry paralel dengan key sama
        if (again) return again;
        const active = this.st.activeForDevice.get(ctx.user.tenantId, deviceId);
        if (active && active.expires_at > iso(this.now())) {
          throw new ApiError(409, 'active_label_exists', 'device sudah punya label ACTIVE; gunakan reissue', { labelId: active.id });
        }
        if (active) this.st.expireOne.run(iso(this.now()), iso(this.now()), active.id);
        const { row, qr } = this.#insertLabelTx(ctx, device, validDays);
        if (key) this.st.idemPut.run(ctx.user.tenantId, ctx.user.userId, key, requestHash, row.id, iso(this.now()));
        return { status: 201, body: this.#issueResponse(row, qr) };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'active_label_exists', 'device sudah punya label ACTIVE; gunakan reissue');
      throw e;
    }
  }

  // ---------- verify ----------

  async verify(ctx, body) {
    const u = ctx.user;
    if (!u.tenantId || !['TENANT_ADMIN', 'CUSTOMER_USER'].includes(u.authority)) throw new ApiError(403, 'forbidden', 'role tidak diizinkan');
    const admin = isAdmin(u);
    let labelId = null;
    let deviceId = null;
    const reject = (reason, status) => {
      this.metrics?.inc('siaga_qr_verify_rejected_total', { reason });
      this.audit(ctx, { action: 'VERIFY_REJECTED', tenantId: u.tenantId, labelId, deviceId, reason });
      // customer user hanya menerima pesan generik
      if (!admin) return { status: reason === 'malformed' ? 400 : 403, body: { valid: false, message: GENERIC_INVALID } };
      const body2 = { valid: false, message: GENERIC_INVALID, reason };
      return { status, body: body2 };
    };

    if (typeof body.qr !== 'string') return reject('malformed', 400);
    let parsed;
    try {
      parsed = this.keys.parseAndVerify(body.qr.trim());
    } catch (e) {
      if (e instanceof QrRejected) return reject(e.reason, 400);
      throw e;
    }
    const { payload, payloadHash } = parsed;
    labelId = payload.labelId.toLowerCase();
    deviceId = payload.deviceId.toLowerCase();
    const nowS = Math.floor(this.now() / 1000);
    const skew = this.config.clockSkewSec;
    if (payload.iat > nowS + skew) return reject('iat_in_future', 400);
    if (payload.exp <= nowS - skew) {
      this.st.expireOne.run(iso(this.now()), iso(this.now()), labelId);
      return reject('expired', 410);
    }
    // label milik tenant lain diperlakukan seperti tidak ada (tidak membocorkan keberadaan)
    if (payload.tenantId.toLowerCase() !== u.tenantId) return reject('tenant_mismatch', 403);
    let row = this.st.label.get(u.tenantId, labelId);
    if (!row) return reject('unknown_label', 400);
    if (row.payload_hash !== payloadHash || row.device_id !== deviceId || row.key_id !== payload.kid) return reject('payload_mismatch', 400);
    if (row.status === 'ACTIVE' && row.expires_at <= iso(this.now())) {
      this.st.expireOne.run(iso(this.now()), iso(this.now()), labelId);
      row = this.st.label.get(u.tenantId, labelId);
    }
    if (row.status !== 'ACTIVE') {
      const r = reject(row.status.toLowerCase(), 410);
      if (admin) r.body.status = row.status;
      return r;
    }
    const device = await this.tb.device(ctx.token, deviceId);
    if (!device || device.tenantId !== u.tenantId) return reject('device_not_accessible', 403);
    if (!admin && device.customerId !== u.customerId) return reject('device_not_accessible', 403);

    this.audit(ctx, { action: 'VERIFIED', tenantId: u.tenantId, labelId, deviceId });
    this.metrics?.inc('siaga_qr_verified_total');
    return {
      status: 200,
      body: {
        valid: true,
        labelId,
        deviceId,
        siteId: device.siteId ?? row.site_id_snapshot,
        deviceName: device.name ?? row.device_name_snapshot,
        kid: row.key_id,
        expiresAt: row.expires_at,
      },
    };
  }

  // ---------- labels ----------

  list(ctx, q) {
    requireAdmin(ctx);
    const tenantId = ctx.user.tenantId;
    this.st.expire.run(iso(this.now()), iso(this.now()), tenantId);
    const limit = Math.min(Math.max(Number.parseInt(q.get('limit') ?? '50', 10) || 50, 1), 200);
    const where = ['tenant_id = ?'];
    const args = [tenantId];
    const deviceId = q.get('deviceId');
    if (deviceId) {
      where.push('device_id = ?');
      args.push(requireUuid(deviceId, 'deviceId'));
    }
    const status = q.get('status');
    if (status) {
      if (!STATUSES.includes(status)) throw new ApiError(400, 'bad_request', `status salah satu: ${STATUSES.join(', ')}`);
      where.push('status = ?');
      args.push(status);
    }
    const query = q.get('query');
    if (query) {
      const s = `%${query.slice(0, 64).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(device_name_snapshot LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR device_id LIKE ? ESCAPE '\\' OR site_id_snapshot LIKE ? ESCAPE '\\')");
      args.push(s, s, s, s);
    }
    const cursor = q.get('cursor');
    if (cursor) {
      let c;
      try {
        c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw new ApiError(400, 'bad_request', 'cursor tidak valid');
      }
      if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') throw new ApiError(400, 'bad_request', 'cursor tidak valid');
      where.push('(issued_at < ? OR (issued_at = ? AND id < ?))');
      args.push(c[0], c[0], c[1]);
    }
    const rows = this.db
      .prepare(`SELECT * FROM siaga_qr_labels WHERE ${where.join(' AND ')} ORDER BY issued_at DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: page.map(publicLabel),
        nextCursor: rows.length > limit && last ? b64u(JSON.stringify([last.issued_at, last.id])) : null,
      },
    };
  }

  #requireLabel(ctx, labelId) {
    const id = requireUuid(labelId, 'labelId');
    const row = this.st.label.get(ctx.user.tenantId, id);
    if (!row) throw new ApiError(404, 'label_not_found', 'label tidak ditemukan');
    return row;
  }

  revoke(ctx, labelId, body) {
    requireAdmin(ctx);
    const reason = clip(typeof body.reason === 'string' ? body.reason.trim() : null, 500);
    return tx(this.db, () => {
      const row = this.#requireLabel(ctx, labelId);
      const t = iso(this.now());
      if (row.status === 'ACTIVE') {
        this.st.revoke.run(t, ctx.user.userId, reason, t, ctx.user.tenantId, row.id);
        this.audit(ctx, { action: 'REVOKED', tenantId: ctx.user.tenantId, labelId: row.id, deviceId: row.device_id, reason });
        this.metrics?.inc('siaga_qr_revoked_total');
      }
      // idempoten: label yang sudah tidak aktif dikembalikan apa adanya
      return { status: 200, body: publicLabel(this.st.label.get(ctx.user.tenantId, row.id)) };
    });
  }

  async reissue(ctx, labelId, body) {
    requireAdmin(ctx);
    const old0 = this.#requireLabel(ctx, labelId);
    const validDays = this.#validDays(body.validForDays);
    const reason = clip(typeof body.reason === 'string' ? body.reason.trim() : 'reissue', 500);
    const key = this.#idemKey(ctx);
    const requestHash = createHash('sha256').update(`reissue|${old0.id}|${validDays}`).digest('hex');
    const replay = this.#idemReplay(ctx, key, requestHash);
    if (replay) return replay;
    const device = await this.#resolveAdminDevice(ctx, old0.device_id);
    try {
      return tx(this.db, () => {
        const again = this.#idemReplay(ctx, key, requestHash);
        if (again) return again;
        const old = this.st.label.get(ctx.user.tenantId, old0.id);
        if (old.replaced_by_label_id) {
          throw new ApiError(409, 'already_replaced', 'label ini sudah diterbitkan ulang', { replacedByLabelId: old.replaced_by_label_id });
        }
        const active = this.st.activeForDevice.get(ctx.user.tenantId, old.device_id);
        if (active && active.id !== old.id) {
          throw new ApiError(409, 'active_label_exists', 'device punya label ACTIVE lain; reissue label itu', { labelId: active.id });
        }
        const t = iso(this.now());
        // label lama dinonaktifkan dulu agar index "satu ACTIVE per device" tidak bentrok
        if (old.status === 'ACTIVE') {
          this.db.prepare("UPDATE siaga_qr_labels SET status = 'REPLACED', updated_at = ? WHERE id = ?").run(t, old.id);
        }
        const { row, qr } = this.#insertLabelTx(ctx, device, validDays, { replacesLabelId: old.id });
        this.st.replace.run(row.id, t, ctx.user.userId, reason, t, ctx.user.tenantId, old.id);
        this.audit(ctx, { action: 'REISSUED', tenantId: ctx.user.tenantId, labelId: old.id, deviceId: old.device_id, reason, metadata: { newLabelId: row.id } });
        if (key) this.st.idemPut.run(ctx.user.tenantId, ctx.user.userId, key, requestHash, row.id, t);
        return { status: 201, body: { ...this.#issueResponse(row, qr), replacesLabelId: old.id } };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'active_label_exists', 'device sudah punya label ACTIVE');
      throw e;
    }
  }

  // ---------- batch ----------

  async #batchOne(ctx, deviceId, { validDays, onlyWithoutActiveLabel }) {
    try {
      const device = await this.tb.device(ctx.token, deviceId);
      if (!device || device.tenantId !== ctx.user.tenantId) return { deviceId, status: 'FAILED', error: 'device_not_found' };
      return tx(this.db, () => {
        const nowIso = iso(this.now());
        let active = this.st.activeForDevice.get(ctx.user.tenantId, deviceId);
        if (active && active.expires_at <= nowIso) {
          this.st.expireOne.run(nowIso, nowIso, active.id);
          active = null;
        }
        if (active && onlyWithoutActiveLabel) return { deviceId, status: 'SKIPPED_ACTIVE_LABEL', labelId: active.id };
        if (active) this.db.prepare("UPDATE siaga_qr_labels SET status = 'REPLACED', updated_at = ? WHERE id = ?").run(nowIso, active.id);
        const { row } = this.#insertLabelTx(ctx, device, validDays, { batch: true, ...(active ? { replacesLabelId: active.id } : {}) });
        if (active) {
          this.st.replace.run(row.id, nowIso, ctx.user.userId, 'batch reissue', nowIso, ctx.user.tenantId, active.id);
          this.audit(ctx, { action: 'REISSUED', tenantId: ctx.user.tenantId, labelId: active.id, deviceId, reason: 'batch reissue', metadata: { newLabelId: row.id } });
          return { deviceId, status: 'REISSUED', labelId: row.id, replacesLabelId: active.id };
        }
        return { deviceId, status: 'CREATED', labelId: row.id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { deviceId, status: 'SKIPPED_ACTIVE_LABEL' };
      this.log.error?.(JSON.stringify({ level: 'error', msg: 'batch item gagal', deviceId, err: e.message }));
      return { deviceId, status: 'FAILED', error: 'internal' };
    }
  }

  async generateBatch(ctx, body) {
    requireAdmin(ctx);
    const validDays = this.#validDays(body.validForDays);
    const onlyWithoutActiveLabel = body.onlyWithoutActiveLabel !== false;
    let deviceIds;
    if (Array.isArray(body.deviceIds) && body.allTenantDevices === undefined) {
      if (body.deviceIds.length === 0) throw new ApiError(400, 'bad_request', 'deviceIds kosong');
      if (body.deviceIds.length > 10_000) throw new ApiError(400, 'bad_request', 'maksimal 10000 device per batch');
      deviceIds = [...new Set(body.deviceIds.map((d) => requireUuid(d, 'deviceIds[]')))];
    } else if (body.allTenantDevices === true && body.deviceIds === undefined) {
      deviceIds = await this.tb.tenantDeviceIds(ctx.token);
    } else {
      throw new ApiError(400, 'bad_request', 'pakai salah satu: deviceIds[] atau allTenantDevices=true');
    }
    const jobId = `qrjob-${uuidv7(this.now())}`;
    const t = iso(this.now());
    const opts = { validDays, onlyWithoutActiveLabel };
    const sync = deviceIds.length <= this.config.syncBatchMax;
    this.st.jobInsert.run(jobId, ctx.user.tenantId, ctx.user.userId, 'RUNNING', deviceIds.length, t, t);
    const run = async () => {
      const items = [];
      const count = { created: 0, skipped: 0, failed: 0 };
      for (const id of deviceIds) {
        const r = await this.#batchOne(ctx, id, opts);
        items.push(r);
        if (r.status === 'CREATED' || r.status === 'REISSUED') count.created++;
        else if (r.status.startsWith('SKIPPED')) count.skipped++;
        else count.failed++;
        if (!sync && items.length % 10 === 0) {
          this.st.jobUpdate.run('RUNNING', items.length, count.created, count.skipped, count.failed, JSON.stringify(items), iso(this.now()), jobId);
        }
      }
      this.st.jobUpdate.run('DONE', items.length, count.created, count.skipped, count.failed, JSON.stringify(items), iso(this.now()), jobId);
      return { jobId, status: 'DONE', total: deviceIds.length, ...count, items };
    };
    if (sync) return { status: 200, body: await run() };
    this.runningJobs.add(jobId);
    run()
      .catch((e) => {
        this.log.error?.(JSON.stringify({ level: 'error', msg: 'batch job gagal', jobId, err: e.message }));
        this.st.jobUpdate.run('FAILED', 0, 0, 0, 0, '[]', iso(this.now()), jobId);
      })
      .finally(() => this.runningJobs.delete(jobId));
    return { status: 202, body: { jobId, status: 'RUNNING', total: deviceIds.length, progressUrl: `jobs/${jobId}` } };
  }

  job(ctx, jobId) {
    requireAdmin(ctx);
    const j = this.st.jobGet.get(ctx.user.tenantId, String(jobId));
    if (!j) throw new ApiError(404, 'job_not_found', 'job tidak ditemukan');
    return {
      status: 200,
      body: {
        jobId: j.id,
        status: j.status,
        total: j.total,
        processed: j.processed,
        created: j.created,
        skipped: j.skipped,
        failed: j.failed,
        items: JSON.parse(j.items),
        createdAt: j.created_at,
        updatedAt: j.updated_at,
      },
    };
  }

  // ---------- export (download singkat, sekali pakai) ----------

  createExport(ctx, body) {
    requireAdmin(ctx);
    let ids = [];
    if (Array.isArray(body.labelIds)) ids = body.labelIds.map((x) => requireUuid(x, 'labelIds[]'));
    else if (typeof body.jobId === 'string') {
      const j = this.st.jobGet.get(ctx.user.tenantId, body.jobId);
      if (!j) throw new ApiError(404, 'job_not_found', 'job tidak ditemukan');
      ids = JSON.parse(j.items).filter((i) => i.labelId && i.status !== 'SKIPPED_ACTIVE_LABEL' && i.status !== 'FAILED').map((i) => i.labelId);
    } else throw new ApiError(400, 'bad_request', 'labelIds[] atau jobId wajib');
    if (ids.length === 0 || ids.length > 5000) throw new ApiError(400, 'bad_request', 'jumlah label 1–5000');
    for (const id of ids) {
      const r = this.st.label.get(ctx.user.tenantId, id);
      if (!r) throw new ApiError(404, 'label_not_found', `label ${id} tidak ditemukan`);
    }
    const token = b64u(randomBytes(24));
    const exp = this.now() + this.config.exportTtlSec * 1000;
    for (const [k, v] of this.exports) if (v.exp <= this.now()) this.exports.delete(k);
    this.exports.set(token, { tenantId: ctx.user.tenantId, userId: ctx.user.userId, labelIds: [...new Set(ids)], exp });
    return { status: 201, body: { downloadPath: `qr/export/${token}`, expiresAt: iso(exp), count: ids.length } };
  }

  /** CSV label ACTIVE untuk dicetak. Hanya untuk admin pembuat token, sekali pakai. */
  consumeExport(ctx, token) {
    requireAdmin(ctx);
    const e = this.exports.get(token);
    this.exports.delete(token);
    if (!e || e.exp <= this.now() || e.tenantId !== ctx.user.tenantId || e.userId !== ctx.user.userId) {
      throw new ApiError(410, 'export_expired', 'link export tidak berlaku');
    }
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = ['labelId,deviceId,deviceName,siteId,status,expiresAt,qr'];
    let exported = 0;
    for (const id of e.labelIds) {
      const r = this.st.label.get(e.tenantId, id);
      if (!r) continue;
      const qr = r.status === 'ACTIVE' ? this.qrOf(r) : null;
      lines.push([r.id, r.device_id, r.device_name_snapshot, r.site_id_snapshot, r.status, r.expires_at, qr ?? ''].map(esc).join(','));
      if (qr) {
        exported++;
        this.audit(ctx, { action: 'PRINT_EXPORTED', tenantId: e.tenantId, labelId: r.id, deviceId: r.device_id });
      }
    }
    return { csv: `${lines.join('\n')}\n`, filename: `siaga-qr-labels-${iso(this.now()).slice(0, 10)}.csv`, exported };
  }
}
