#!/usr/bin/env node
// Buat pasangan key Ed25519 baru (+ data key bila belum ada).
//   node scripts/keygen.mjs --kid siaga-qr-2026-01 --out /etc/siaga-qr
// Hasil:
//   <out>/private/<kid>.key   (chmod 600, HANYA untuk SIAGA_QR_SIGNING_KEY_FILE)
//   <out>/public/<kid>.pub    (SIAGA_QR_PUBLIC_KEYS_DIR; simpan semua kid lama di sini)
//   <out>/private/data.key    (SIAGA_QR_DATA_KEY_FILE, 32 byte base64; JANGAN diganti setelah dipakai)
// Key tidak pernah dicetak ke layar.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const kid = arg('kid');
const out = arg('out');
if (!kid || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(kid) || !out) {
  console.error('pakai: node scripts/keygen.mjs --kid siaga-qr-2026-01 --out /etc/siaga-qr');
  process.exit(1);
}
const priv = join(out, 'private');
const pub = join(out, 'public');
mkdirSync(priv, { recursive: true, mode: 0o700 });
mkdirSync(pub, { recursive: true });
const keyFile = join(priv, `${kid}.key`);
if (existsSync(keyFile)) {
  console.error(`${keyFile} sudah ada; pilih kid baru untuk rotasi`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
chmodSync(keyFile, 0o600);
writeFileSync(join(pub, `${kid}.pub`), publicKey.export({ type: 'spki', format: 'pem' }));
const dataKey = join(priv, 'data.key');
if (!existsSync(dataKey)) writeFileSync(dataKey, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
console.log(`ok: ${keyFile} (600), ${join(pub, `${kid}.pub`)}${existsSync(dataKey) ? `, ${dataKey}` : ''}`);
