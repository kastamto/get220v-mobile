/**
 * Key ring Ed25519 + format QR.
 *
 * - Satu signing key aktif (SIAGA_QR_SIGNING_KEY_FILE, kid = SIAGA_QR_ACTIVE_KID).
 * - Semua public key verifikasi di SIAGA_QR_PUBLIC_KEYS_DIR/<kid>.pub, jadi label key lama
 *   tetap bisa diverifikasi setelah rotasi.
 * - Data key (32 byte) untuk mengenkripsi nonce di DB (AES-256-GCM) dan hash IP audit.
 * Startup fail closed: key hilang/tidak cocok -> throw, tidak pernah menerbitkan QR tanpa tanda tangan.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { KID_RE, UUID_RE } from './config.js';

export const QR_PREFIX = 'siaga://v1/device/';
const QR_RE = /^siaga:\/\/v1\/device\/([A-Za-z0-9_-]{16,1024})\.([A-Za-z0-9_-]{86})$/;
const MAX_QR_LEN = 1200;

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** JSON deterministik: key diurutkan, tanpa spasi. */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(',')}}`;
}

export class KeyError extends Error {}

export class KeyRing {
  /** @param {{activeKid:string, signingKeyFile:string, publicKeysDir:string, dataKeyFile:string, log?:Console}} o */
  static load({ activeKid, signingKeyFile, publicKeysDir, dataKeyFile, log = console }) {
    const publicKeys = new Map();
    for (const f of readdirSync(publicKeysDir)) {
      if (!f.endsWith('.pub')) continue;
      const kid = basename(f, '.pub');
      if (!KID_RE.test(kid)) throw new KeyError(`nama public key tidak valid: ${f}`);
      const key = createPublicKey(readFileSync(join(publicKeysDir, f)));
      if (key.asymmetricKeyType !== 'ed25519') throw new KeyError(`${f} bukan Ed25519`);
      publicKeys.set(kid, key);
    }
    const mode = statSync(signingKeyFile).mode & 0o077;
    if (mode) log.warn?.(`[keys] ${signingKeyFile} bisa dibaca group/other; set chmod 600`);
    const privateKey = createPrivateKey(readFileSync(signingKeyFile));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new KeyError('signing key bukan Ed25519');
    const dataKey = Buffer.from(readFileSync(dataKeyFile, 'utf8').trim(), 'base64');
    return new KeyRing({ activeKid, privateKey, publicKeys, dataKey });
  }

  constructor({ activeKid, privateKey, publicKeys, dataKey }) {
    if (!KID_RE.test(activeKid)) throw new KeyError('kid aktif tidak valid');
    if (!dataKey || dataKey.length !== 32) throw new KeyError('data key harus 32 byte (base64)');
    const pub = publicKeys.get(activeKid);
    if (!pub) throw new KeyError(`public key untuk kid aktif "${activeKid}" tidak ada`);
    // private & public kid aktif harus pasangan yang sama
    const probe = randomBytes(32);
    if (!verify(null, probe, pub, sign(null, probe, privateKey))) {
      throw new KeyError(`signing key tidak cocok dengan ${activeKid}.pub`);
    }
    this.activeKid = activeKid;
    this.privateKey = privateKey;
    this.publicKeys = publicKeys;
    this.nonceKey = Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), 'siaga-qr nonce v1', 32));
    this.ipKey = Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), 'siaga-qr ip v1', 32));
  }

  get kids() {
    return [...this.publicKeys.keys()];
  }

  /** Payload -> {qr, payloadB64, payloadHash}. Tanda tangan atas byte ASCII payload Base64URL. */
  signPayload(payload) {
    if (payload.kid !== this.activeKid) throw new KeyError(`hanya kid aktif (${this.activeKid}) yang bisa menandatangani`);
    const canonical = canonicalJson(payload);
    const payloadB64 = b64u(canonical);
    const sig = sign(null, Buffer.from(payloadB64, 'ascii'), this.privateKey);
    return { qr: `${QR_PREFIX}${payloadB64}.${b64u(sig)}`, payloadB64, payloadHash: sha256(canonical) };
  }

  /**
   * Validasi format + kid + tanda tangan + bentuk payload (langkah 1–3 verify).
   * @returns {{payload, payloadHash}} atau throw QrRejected
   */
  parseAndVerify(qr) {
    if (typeof qr !== 'string' || qr.length > MAX_QR_LEN) throw new QrRejected('malformed');
    const m = QR_RE.exec(qr);
    if (!m) throw new QrRejected('malformed');
    const [, payloadB64, sigB64] = m;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new QrRejected('malformed');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new QrRejected('malformed');
    if (payload.v !== 1) throw new QrRejected('unknown_version');
    const pub = typeof payload.kid === 'string' ? this.publicKeys.get(payload.kid) : undefined;
    if (!pub) throw new QrRejected('unknown_kid');
    const sig = Buffer.from(sigB64, 'base64url');
    // base64url kanonik saja: karakter terakhir punya 4 bit sisa, varian lain = QR berbeda
    if (sig.length !== 64 || b64u(sig) !== sigB64 || !verify(null, Buffer.from(payloadB64, 'ascii'), pub, sig)) throw new QrRejected('bad_signature');
    // payload harus persis bentuk kanonik (tidak ada field tambahan / urutan lain)
    const keys = Object.keys(payload).sort().join(',');
    if (keys !== 'deviceId,exp,iat,kid,labelId,nonce,tenantId,v') throw new QrRejected('malformed');
    const canonical = canonicalJson(payload);
    if (b64u(canonical) !== payloadB64) throw new QrRejected('malformed');
    if (![payload.labelId, payload.deviceId, payload.tenantId].every((x) => typeof x === 'string' && UUID_RE.test(x))) {
      throw new QrRejected('malformed');
    }
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || typeof payload.nonce !== 'string') {
      throw new QrRejected('malformed');
    }
    return { payload, payloadHash: sha256(canonical) };
  }

  encryptNonce(nonce, labelId) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.nonceKey, iv);
    c.setAAD(Buffer.from(labelId));
    const ct = Buffer.concat([c.update(nonce, 'utf8'), c.final()]);
    return `v1.${b64u(iv)}.${b64u(ct)}.${b64u(c.getAuthTag())}`;
  }

  decryptNonce(enc, labelId) {
    const [v, iv, ct, tag] = String(enc).split('.');
    if (v !== 'v1') throw new KeyError('format nonce terenkripsi tidak dikenal');
    const d = createDecipheriv('aes-256-gcm', this.nonceKey, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(labelId));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  hashIp(ip) {
    return ip ? createHmac('sha256', this.ipKey).update(String(ip)).digest('hex').slice(0, 32) : null;
  }
}

export class QrRejected extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** UUIDv7: 48 bit waktu ms + random (urut waktu, cocok untuk cursor & index). */
export function uuidv7(now = Date.now()) {
  const b = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
