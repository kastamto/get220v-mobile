import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { KeyRing, KeyError } from '../src/keys.js';
import { createQrServer } from '../src/server.js';
import { startMockTb, TOKENS, T1, CU2, D1, D2, D3 } from './mockTb.js';

const KID1 = 'siaga-qr-2026-01';
const KID2 = 'siaga-qr-2027-01';
const pair = () => generateKeyPairSync('ed25519');
const k1 = pair();
const k2 = pair();
const dataKey = randomBytes(32);
const ring1 = () => new KeyRing({ activeKid: KID1, privateKey: k1.privateKey, publicKeys: new Map([[KID1, k1.publicKey]]), dataKey });

let tb;
let clock = Date.now();
const now = () => clock;
const logs = [];
const log = { log: (s) => logs.push(String(s)), error: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) };
let db;
let app;
let base;

const config = (over = {}) => ({
  tbInternalUrl: '',
  defaultValidDays: 1825,
  maxValidDays: 3650,
  clockSkewSec: 300,
  syncBatchMax: 3,
  maxBodyBytes: 16_384,
  rateLimitPerMin: 10_000,
  verifyRateLimitPerMin: 10_000,
  ipRateLimitPerMin: 100_000,
  authCacheSec: 30,
  exportTtlSec: 300,
  corsOrigins: [],
  trustProxy: true,
  ...over,
});

async function startApp(keys, over = {}) {
  const a = createQrServer({ ...config(over), tbInternalUrl: tb.url }, { db, keys, now, log });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  return { ...a, base: `http://127.0.0.1:${a.server.address().port}/api/siaga/v1` };
}
const stop = (a) => {
  a.server.close();
  a.server.closeAllConnections();
};

async function call(method, path, token, body, headers = {}, b = base) {
  const res = await fetch(`${b}${path}`, {
    method,
    headers: { ...(token ? { 'X-Authorization': `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* csv */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const gen = (deviceId, token = TOKENS.adminA, headers = {}) => call('POST', '/qr/generate', token, { deviceId }, headers);
const ver = (qr, token) => call('POST', '/qr/verify', token, { qr });
const audits = () => db.prepare('SELECT * FROM siaga_qr_audit ORDER BY at, id').all();

before(async () => {
  tb = await startMockTb({ extraT1Devices: 5 });
  db = openDb(':memory:');
  app = await startApp(ring1());
  base = app.base;
});

after(() => {
  stop(app);
  tb.server.close();
  tb.server.closeAllConnections();
});

test('health, openapi, auth: tanpa token / token kedaluwarsa 401, SYS_ADMIN 403', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/ready')).body.kid, KID1);
  assert.match((await call('GET', '/openapi.yaml')).text, /openapi: 3/);
  assert.equal((await gen(D1, null)).status, 401);
  assert.equal((await gen(D1, TOKENS.expired)).status, 401);
  assert.equal((await gen(D1, TOKENS.sys)).status, 403);
  assert.equal((await ver('siaga://v1/device/x.y', TOKENS.sys)).status, 403);
});

test('#1 customer user 403 untuk generate/revoke/reissue/list/batch', async () => {
  const lid = '01900000-0000-7000-8000-000000000000';
  assert.equal((await gen(D1, TOKENS.cust1)).status, 403);
  assert.equal((await call('POST', `/qr/labels/${lid}/revoke`, TOKENS.cust1, {})).status, 403);
  assert.equal((await call('POST', `/qr/labels/${lid}/reissue`, TOKENS.cust1, {})).status, 403);
  assert.equal((await call('GET', '/qr/labels', TOKENS.cust1)).status, 403);
  assert.equal((await call('POST', '/qr/generate-batch', TOKENS.cust1, { deviceIds: [D1] })).status, 403);
});

test('#2 admin tidak bisa membuat label untuk device tenant lain', async () => {
  const r = await gen(D3, TOKENS.adminA);
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM siaga_qr_labels WHERE device_id = ?').get(D3).n, 0);
});

let qrD1;
let labelD1;
test('generate -> verify admin & customer pemilik; #3 tenant lain & #6 customer lain ditolak', async () => {
  const r = await gen(D1);
  assert.equal(r.status, 201);
  assert.match(r.body.qr, /^siaga:\/\/v1\/device\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  assert.equal(r.body.deviceName, 'MURAYA-GWT-01');
  assert.equal(r.body.siteId, 'Muraya');
  assert.equal(r.body.kid, KID1);
  assert.equal(r.body.status, 'ACTIVE');
  const days = (Date.parse(r.body.expiresAt) - Date.parse(r.body.issuedAt)) / 86_400_000;
  assert.equal(days, 1825);
  qrD1 = r.body.qr;
  labelD1 = r.body.labelId;
  const payload = JSON.parse(Buffer.from(qrD1.split('/').at(-1).split('.')[0], 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['deviceId', 'exp', 'iat', 'kid', 'labelId', 'nonce', 'tenantId', 'v']);
  assert.equal(payload.tenantId, T1);

  const a = await ver(qrD1, TOKENS.adminA);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { valid: true, labelId: labelD1, deviceId: D1, siteId: 'Muraya', deviceName: 'MURAYA-GWT-01', kid: KID1, expiresAt: r.body.expiresAt });
  assert.equal((await ver(qrD1, TOKENS.cust1)).status, 200);

  const c2 = await ver(qrD1, TOKENS.cust2);
  assert.equal(c2.status, 403);
  assert.deepEqual(c2.body, { valid: false, message: 'QR tidak valid atau tidak dapat digunakan.' });
  const b = await ver(qrD1, TOKENS.adminB);
  assert.equal(b.status, 403);
  assert.equal(b.body.valid, false);

  // device sudah punya label ACTIVE -> 409 + labelId
  const dup = await gen(D1);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.labelId, labelD1);
});

test('#4 perubahan satu byte pada payload/tanda tangan selalu ditolak', async () => {
  const [prefix, rest] = [qrD1.slice(0, 'siaga://v1/device/'.length), qrD1.slice('siaga://v1/device/'.length)];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let checked = 0;
  for (let i = 0; i < rest.length; i += 3) {
    if (rest[i] === '.') continue;
    const swap = alphabet[(alphabet.indexOf(rest[i]) + 1) % alphabet.length];
    const bad = prefix + rest.slice(0, i) + swap + rest.slice(i + 1);
    const r = await ver(bad, TOKENS.adminA);
    assert.notEqual(r.status, 200, `posisi ${i} lolos`);
    assert.equal(r.body.valid, false);
    checked++;
  }
  assert.ok(checked > 100);
});

test('#5 kid tidak dikenal, URI rusak, expired, iat di masa depan ditolak', async () => {
  // kid lain (tidak ada di key ring)
  const other = new KeyRing({ activeKid: 'unknown-kid', privateKey: k2.privateKey, publicKeys: new Map([['unknown-kid', k2.publicKey]]), dataKey });
  const forged = other.signPayload({ v: 1, kid: 'unknown-kid', labelId: labelD1, deviceId: D1, tenantId: T1, iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 99, nonce: 'x' });
  const r1 = await ver(forged.qr, TOKENS.adminA);
  assert.equal(r1.status, 400);
  assert.equal(r1.body.reason, 'unknown_kid');
  // ditandatangani key asing tapi mengaku kid aktif
  const imposter = new KeyRing({ activeKid: KID1, privateKey: k2.privateKey, publicKeys: new Map([[KID1, k2.publicKey]]), dataKey });
  const r2 = await ver(imposter.signPayload({ v: 1, kid: KID1, labelId: labelD1, deviceId: D1, tenantId: T1, iat: 1, exp: 9e9, nonce: 'x' }).qr, TOKENS.adminA);
  assert.equal(r2.body.reason, 'bad_signature');
  for (const bad of ['', 'siaga://v2/device/abc.def', 'http://evil', `${qrD1}x`, qrD1.replace('siaga://', 'SIAGA://'), 'x'.repeat(5000)]) {
    const r = await ver(bad, TOKENS.adminA);
    assert.equal(r.status, 400, bad.slice(0, 30));
  }
  assert.equal((await call('POST', '/qr/verify', TOKENS.cust1, { qr: 123 })).status, 400);

  // iat di masa depan: diterbitkan dengan jam yang maju 1 jam
  const t0 = clock;
  clock = t0 + 3_600_000;
  const fut = await gen(D2);
  assert.equal(fut.status, 201);
  clock = t0;
  const rf = await ver(fut.body.qr, TOKENS.adminA);
  assert.equal(rf.body.reason, 'iat_in_future');
  // expired: label 1 hari, jam maju 2 hari
  await call('POST', `/qr/labels/${fut.body.labelId}/revoke`, TOKENS.adminA, { reason: 'test' });
  const short = await call('POST', '/qr/generate', TOKENS.adminA, { deviceId: D2, validForDays: 1 });
  assert.equal(short.status, 201);
  clock = t0 + 2 * 86_400_000;
  const re = await ver(short.body.qr, TOKENS.adminA);
  assert.equal(re.status, 410);
  assert.equal(re.body.reason, 'expired');
  clock = t0;
  assert.equal(db.prepare('SELECT status FROM siaga_qr_labels WHERE id = ?').get(short.body.labelId).status, 'EXPIRED');
});

test('#6 device yang tidak lagi di-assign ke customer ditolak', async () => {
  tb.state.devices[D1].customer = CU2;
  try {
    assert.equal((await ver(qrD1, TOKENS.cust1)).status, 403);
    assert.equal((await ver(qrD1, TOKENS.cust2)).status, 200);
  } finally {
    tb.state.devices[D1].customer = 'c1000000-0000-0000-0000-000000000001';
  }
});

test('#7 Idempotency-Key yang sama -> satu label; body beda -> 422', async () => {
  const dev = 'e0000000-0000-0000-0000-000000000000';
  const h = { 'Idempotency-Key': 'print-job-0001' };
  const a = await gen(dev, TOKENS.adminA, h);
  const b = await gen(dev, TOKENS.adminA, h);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.labelId, a.body.labelId);
  assert.equal(b.body.qr, a.body.qr, 'QR dibangun ulang identik');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM siaga_qr_labels WHERE device_id = ?').get(dev).n, 1);
  const c = await call('POST', '/qr/generate', TOKENS.adminA, { deviceId: dev, validForDays: 30 }, h);
  assert.equal(c.status, 422);
});

test('#8 generate paralel tidak melanggar "satu ACTIVE per device"', async () => {
  const dev = 'e0000000-0000-0000-0000-000000000001';
  const rs = await Promise.all(Array.from({ length: 6 }, () => gen(dev)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM siaga_qr_labels WHERE device_id = ? AND status = 'ACTIVE'").get(dev).n, 1);
});

test('revoke idempoten; label dicabut gagal verify (admin 410, customer generik)', async () => {
  const before = audits().filter((a) => a.action === 'REVOKED').length;
  const r1 = await call('POST', `/qr/labels/${labelD1}/revoke`, TOKENS.adminA, { reason: 'Label rusak' });
  const r2 = await call('POST', `/qr/labels/${labelD1}/revoke`, TOKENS.adminA, { reason: 'lagi' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'REVOKED');
  assert.equal(r1.body.revokeReason, 'Label rusak');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.revokeReason, 'Label rusak');
  assert.equal(audits().filter((a) => a.action === 'REVOKED').length, before + 1);
  const a = await ver(qrD1, TOKENS.adminA);
  assert.equal(a.status, 410);
  assert.equal(a.body.status, 'REVOKED');
  const c = await ver(qrD1, TOKENS.cust1);
  assert.equal(c.status, 403);
  assert.deepEqual(c.body, { valid: false, message: 'QR tidak valid atau tidak dapat digunakan.' });
  // tenant lain tidak bisa mencabut
  assert.equal((await call('POST', `/qr/labels/${labelD1}/revoke`, TOKENS.adminB, {})).status, 404);
});

test('#9 reissue: label lama REPLACED & langsung gagal, label baru valid', async () => {
  const dev = 'e0000000-0000-0000-0000-000000000001';
  const old = db.prepare("SELECT * FROM siaga_qr_labels WHERE device_id = ? AND status = 'ACTIVE'").get(dev);
  const oldQr = app.service.qrOf(old);
  assert.equal((await ver(oldQr, TOKENS.adminA)).status, 200);
  const r = await call('POST', `/qr/labels/${old.id}/reissue`, TOKENS.adminA, { reason: 'device dipindahkan' });
  assert.equal(r.status, 201);
  assert.equal(r.body.replacesLabelId, old.id);
  const oldRow = db.prepare('SELECT * FROM siaga_qr_labels WHERE id = ?').get(old.id);
  assert.equal(oldRow.status, 'REPLACED');
  assert.equal(oldRow.replaced_by_label_id, r.body.labelId);
  const v = await ver(oldQr, TOKENS.adminA);
  assert.equal(v.status, 410);
  assert.equal(v.body.status, 'REPLACED');
  assert.equal((await ver(r.body.qr, TOKENS.adminA)).status, 200);
  assert.equal((await call('POST', `/qr/labels/${old.id}/reissue`, TOKENS.adminA, {})).status, 409);
  const acts = audits().filter((a) => a.label_id === old.id || a.label_id === r.body.labelId).map((a) => a.action);
  assert.ok(acts.includes('REISSUED') && acts.includes('GENERATED'));
});

test('#10 batch onlyWithoutActiveLabel tidak membuat duplikat; batch besar jadi job', async () => {
  const ids = ['e0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000003', D3];
  const a = await call('POST', '/qr/generate-batch', TOKENS.adminA, { deviceIds: ids });
  assert.equal(a.status, 200);
  assert.equal(a.body.created, 2);
  assert.equal(a.body.failed, 1, 'device tenant lain gagal per item, tidak menggagalkan batch');
  assert.equal(a.body.items.find((i) => i.deviceId === D3).error, 'device_not_found');
  const b = await call('POST', '/qr/generate-batch', TOKENS.adminA, { deviceIds: ids });
  assert.equal(b.body.created, 0);
  assert.equal(b.body.skipped, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM siaga_qr_labels WHERE device_id IN (?, ?)").get(ids[0], ids[1]).n, 2);
  assert.equal((await call('POST', '/qr/generate-batch', TOKENS.adminA, { deviceIds: [D1], allTenantDevices: true })).status, 400);

  // semua device tenant (7 > syncBatchMax 3) -> background job
  const j = await call('POST', '/qr/generate-batch', TOKENS.adminA, { allTenantDevices: true });
  assert.equal(j.status, 202);
  let st;
  for (let i = 0; i < 50; i++) {
    st = await call('GET', `/qr/jobs/${j.body.jobId}`, TOKENS.adminA);
    if (st.body.status === 'DONE') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(st.body.status, 'DONE');
  assert.equal(st.body.total, 7);
  assert.equal(st.body.created + st.body.skipped, 7);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM (SELECT device_id FROM siaga_qr_labels WHERE tenant_id = ? AND status = 'ACTIVE' GROUP BY device_id HAVING COUNT(*) > 1)").get(T1).n, 0);
  assert.equal((await call('GET', `/qr/jobs/${j.body.jobId}`, TOKENS.adminB)).status, 404);

  // export label dari job -> CSV sekali pakai
  const ex = await call('POST', '/qr/export', TOKENS.adminA, { jobId: j.body.jobId });
  assert.equal(ex.status, 201);
  assert.equal((await call('GET', `/${ex.body.downloadPath}`, TOKENS.adminB)).status, 410, 'admin lain tidak bisa memakai link');
  const ex2 = await call('POST', '/qr/export', TOKENS.adminA, { jobId: j.body.jobId });
  const csv = await call('GET', `/${ex2.body.downloadPath}`, TOKENS.adminA);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const rows = csv.text.trim().split('\n');
  assert.equal(rows[0], 'labelId,deviceId,deviceName,siteId,status,expiresAt,qr');
  const someQr = rows[1].split(',').at(-1);
  assert.equal((await ver(someQr, TOKENS.adminA)).status, 200, 'QR hasil export valid');
  assert.equal((await call('GET', `/${ex2.body.downloadPath}`, TOKENS.adminA)).status, 410, 'sekali pakai');
  assert.ok(audits().some((a) => a.action === 'PRINT_EXPORTED'));
});

test('list: cursor, filter, tanpa nilai QR', async () => {
  const p1 = await call('GET', '/qr/labels?limit=3', TOKENS.adminA);
  assert.equal(p1.status, 200);
  assert.equal(p1.body.data.length, 3);
  assert.ok(p1.body.nextCursor);
  assert.ok(!JSON.stringify(p1.body).includes('siaga://'));
  const p2 = await call('GET', `/qr/labels?limit=3&cursor=${p1.body.nextCursor}`, TOKENS.adminA);
  const ids1 = new Set(p1.body.data.map((l) => l.labelId));
  assert.ok(p2.body.data.every((l) => !ids1.has(l.labelId)));
  const rev = await call('GET', '/qr/labels?status=REVOKED', TOKENS.adminA);
  assert.ok(rev.body.data.length >= 1 && rev.body.data.every((l) => l.status === 'REVOKED'));
  const q = await call('GET', '/qr/labels?query=MURAYA', TOKENS.adminA);
  assert.ok(q.body.data.every((l) => l.deviceName === 'MURAYA-GWT-01'));
  const other = await call('GET', '/qr/labels', TOKENS.adminB);
  assert.equal(other.body.data.length, 0, 'tenant lain tidak melihat label T1');
  assert.equal((await call('GET', '/qr/labels?status=BOGUS', TOKENS.adminA)).status, 400);
});

test('#11 audit immutable dengan actor & waktu', async () => {
  const rows = audits();
  for (const action of ['GENERATED', 'REVOKED', 'REISSUED', 'VERIFIED', 'VERIFY_REJECTED']) {
    const r = rows.find((x) => x.action === action);
    assert.ok(r, action);
    assert.ok(r.actor_user_id && r.at && r.tenant_id, action);
  }
  assert.ok(rows.find((x) => x.action === 'GENERATED').actor_name);
  assert.throws(() => db.prepare("UPDATE siaga_qr_audit SET reason = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM siaga_qr_audit').run(), /append-only/);
});

test('#12 log & audit tanpa JWT, QR lengkap, atau private key', async () => {
  const all = logs.join('\n') + JSON.stringify(audits());
  for (const t of Object.values(TOKENS)) assert.ok(!all.includes(t.split('.')[1]), 'JWT bocor');
  assert.ok(!all.includes('siaga://'), 'QR bocor');
  assert.ok(!all.includes('PRIVATE KEY'), 'private key bocor');
});

test('#13 restart service tidak mengubah verifikasi label aktif', async () => {
  const fresh = db.prepare("SELECT * FROM siaga_qr_labels WHERE status = 'ACTIVE' AND key_id = ? LIMIT 1").get(KID1);
  const qr = app.service.qrOf(fresh);
  const app2 = await startApp(ring1());
  try {
    assert.equal((await call('POST', '/qr/verify', TOKENS.adminA, { qr }, {}, app2.base)).status, 200);
  } finally {
    stop(app2);
  }
});

test('#14 rotasi key: label kid lama tetap valid, label baru memakai kid baru', async () => {
  const oldRow = db.prepare("SELECT * FROM siaga_qr_labels WHERE status = 'ACTIVE' AND key_id = ? LIMIT 1").get(KID1);
  const oldQr = app.service.qrOf(oldRow);
  const ring2 = new KeyRing({ activeKid: KID2, privateKey: k2.privateKey, publicKeys: new Map([[KID1, k1.publicKey], [KID2, k2.publicKey]]), dataKey });
  const app3 = await startApp(ring2);
  try {
    assert.equal((await call('POST', '/qr/verify', TOKENS.adminA, { qr: oldQr }, {}, app3.base)).status, 200);
    const r = await call('POST', `/qr/labels/${oldRow.id}/reissue`, TOKENS.adminA, {}, {}, app3.base);
    assert.equal(r.status, 201);
    assert.equal(r.body.kid, KID2);
    assert.equal((await call('POST', '/qr/verify', TOKENS.adminA, { qr: r.body.qr }, {}, app3.base)).status, 200);
    // key ring lama (tanpa public KID2) tidak mengenal label baru
    assert.equal((await ver(r.body.qr, TOKENS.adminA)).body.reason, 'unknown_kid');
  } finally {
    stop(app3);
  }
});

test('KeyRing fail closed: key hilang / tidak cocok / data key salah', () => {
  const dir = mkdtempSync(join(tmpdir(), 'siaga-keys-'));
  mkdirSync(join(dir, 'pub'));
  writeFileSync(join(dir, 'pub', `${KID1}.pub`), k1.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(dir, 'k1.key'), k1.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'k2.key'), k2.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'data.key'), dataKey.toString('base64'), { mode: 0o600 });
  writeFileSync(join(dir, 'short.key'), randomBytes(8).toString('base64'));
  const o = { activeKid: KID1, publicKeysDir: join(dir, 'pub'), dataKeyFile: join(dir, 'data.key'), log: { warn() {} } };
  assert.ok(KeyRing.load({ ...o, signingKeyFile: join(dir, 'k1.key') }));
  assert.throws(() => KeyRing.load({ ...o, signingKeyFile: join(dir, 'missing.key') }));
  assert.throws(() => KeyRing.load({ ...o, signingKeyFile: join(dir, 'k2.key') }), KeyError);
  assert.throws(() => KeyRing.load({ ...o, activeKid: KID2, signingKeyFile: join(dir, 'k2.key') }), KeyError);
  assert.throws(() => KeyRing.load({ ...o, signingKeyFile: join(dir, 'k1.key'), dataKeyFile: join(dir, 'short.key') }), KeyError);
});

test('validasi input: body terlalu besar, JSON rusak, validForDays di-clamp', async () => {
  const big = await call('POST', '/qr/verify', TOKENS.adminA, { qr: 'x'.repeat(20_000) });
  assert.equal(big.status, 413);
  const bad = await fetch(`${base}/qr/generate`, { method: 'POST', headers: { 'X-Authorization': `Bearer ${TOKENS.adminA}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  const dev = 'e0000000-0000-0000-0000-000000000004';
  db.prepare("UPDATE siaga_qr_labels SET status = 'REVOKED' WHERE device_id = ? AND status = 'ACTIVE'").run(dev);
  const r = await call('POST', '/qr/generate', TOKENS.adminA, { deviceId: dev, validForDays: 99_999 });
  assert.equal(r.status, 201);
  assert.equal((Date.parse(r.body.expiresAt) - Date.parse(r.body.issuedAt)) / 86_400_000, 3650);
  assert.equal((await call('POST', '/qr/generate', TOKENS.adminA, { deviceId: 'bukan-uuid' })).status, 400);
});
