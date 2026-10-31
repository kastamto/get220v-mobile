# SIAGA Device QR (server-registered)

Layanan label QR device SIAGA di `https://iot.get220v.com/api/siaga/v1`. Setiap label
diregistrasikan ke device ThingsBoard, ditandatangani Ed25519, punya lifecycle
(`ACTIVE`/`REVOKED`/`EXPIRED`/`REPLACED`) dan audit trail yang tidak bisa diubah.

- **Node ≥ 22.13, tanpa dependency.** Database memakai SQLite bawaan (`node:sqlite`, satu file,
  WAL) dan kriptografi memakai `node:crypto`.
- **Tidak ada kredensial ThingsBoard di service.** Setiap request memakai JWT user pemanggil.
  ThingsBoard sendiri yang menentukan device mana yang boleh dilihat user itu (tenant admin →
  device tenant-nya, customer user → device customer-nya). Service mengecek ulang tenant sebagai
  lapis kedua.
- Tenant, customer, actor, `kid`, waktu terbit, dan expiry selalu ditentukan server. Body dari
  handset hanya memilih device atau label.

## Endpoint

| Method | Path | Role | Keterangan |
| --- | --- | --- | --- |
| POST | `/qr/generate` | TENANT_ADMIN | `{deviceId, validForDays?}` → 201. Mendukung `Idempotency-Key`. Kalau device sudah punya label ACTIVE → `409` + `labelId` (pakai reissue). |
| POST | `/qr/verify` | TENANT_ADMIN, CUSTOMER_USER | `{qr}` → `{valid:true,…}`. Penolakan untuk customer selalu pesan generik. |
| GET | `/qr/labels` | TENANT_ADMIN | `limit`, `cursor`, `deviceId`, `status`, `query`. Tanpa nilai QR. |
| POST | `/qr/labels/{id}/revoke` | TENANT_ADMIN | `{reason}`, idempoten. |
| POST | `/qr/labels/{id}/reissue` | TENANT_ADMIN | Atomik: label lama `REPLACED` + label baru. Mendukung `Idempotency-Key`. |
| POST | `/qr/generate-batch` | TENANT_ADMIN | `{deviceIds}` atau `{allTenantDevices:true}`. Sampai 100 device sinkron (200); lebih dari itu job (202). |
| GET | `/qr/jobs/{jobId}` | TENANT_ADMIN | Progres job batch. |
| POST | `/qr/export` → GET `/qr/export/{token}` | TENANT_ADMIN | CSV untuk cetak. Link sekali pakai, 5 menit, hanya untuk admin yang sama. |
| GET | `/health`, `/ready`, `/openapi.yaml` | publik | Liveness, readiness (DB + key), spesifikasi. |
| GET | `/metrics` (port lokal saja) | — | Format Prometheus. Tidak diteruskan nginx. |

Kontrak lengkap ada di [`openapi.yaml`](openapi.yaml).

### Contoh `curl`

```bash
API=https://iot.get220v.com/api/siaga/v1
# token login ThingsBoard (jangan simpan di history: read -s)
read -s JWT
H="X-Authorization: Bearer $JWT"

curl -s -X POST "$API/qr/generate" -H "$H" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: print-$(date +%s)" -d '{"deviceId":"<uuid device>"}'
curl -s -X POST "$API/qr/verify" -H "$H" -H 'Content-Type: application/json' -d '{"qr":"siaga://v1/device/…"}'
curl -s "$API/qr/labels?limit=20&status=ACTIVE" -H "$H"
curl -s -X POST "$API/qr/labels/<labelId>/revoke" -H "$H" -H 'Content-Type: application/json' -d '{"reason":"Label rusak"}'
curl -s -X POST "$API/qr/labels/<labelId>/reissue" -H "$H" -H 'Content-Type: application/json' -d '{"reason":"Device dipindah"}'
curl -s -X POST "$API/qr/generate-batch" -H "$H" -H 'Content-Type: application/json' -d '{"allTenantDevices":true}'
```

## Format QR

```
siaga://v1/device/<base64url(canonical JSON payload)>.<base64url(Ed25519 signature)>
payload = {"deviceId","exp","iat","kid","labelId","nonce","tenantId","v":1}   (key terurut, tanpa spasi)
```

Tanda tangan dibuat atas byte ASCII payload Base64URL. Verifikasi berjalan berurutan:

1. format dan ukuran (base64url kanonik, field persis, UUID);
2. `kid` dikenal;
3. tanda tangan;
4. `iat`/`exp` dengan skew ±300 detik;
5. tenant cocok dengan user;
6. label ada dan `ACTIVE`;
7. hash payload sama dengan record;
8. device masih ada dan masih boleh dilihat user di ThingsBoard.

Nonce disimpan terenkripsi (AES-256-GCM, data key) dan nilai QR lengkap tidak disimpan. Label
ACTIVE dengan `kid` aktif bisa dibangun ulang byte-per-byte, karena Ed25519 deterministik. Ini
yang dipakai untuk replay `Idempotency-Key` dan export cetak.

## Data

| Tabel | Isi |
| --- | --- |
| `siaga_qr_labels` | Lifecycle label. Index unik parsial menjamin **maksimal satu ACTIVE per device**, termasuk saat generate berjalan paralel. |
| `siaga_qr_audit` | Append-only. Trigger menolak UPDATE/DELETE. Isi: actor, aksi, waktu UTC, correlation ID, hash IP (HMAC), user-agent, `X-App-Version`. Tanpa JWT, QR lengkap, atau key. |
| `siaga_qr_idempotency`, `siaga_qr_jobs` | Replay idempotency dan progres batch. |

## Deploy (VPS, PM2 + nginx)

```bash
cd /opt/get220v && git -C get220v-mobile pull   # atau salin services/siaga-qr
cp -r get220v-mobile/services/siaga-qr /opt/get220v/get220v-siaga-qr && cd /opt/get220v/get220v-siaga-qr
node --version                                  # harus >= 22.13 (pakai /opt/nodejs/node22 bila perlu)
npm test                                        # 19 test, harus lulus

# 1. secret (sekali). Key tidak pernah tampil di layar.
sudo install -d -m 700 /etc/siaga-qr
sudo node scripts/keygen.mjs --kid siaga-qr-2026-01 --out /etc/siaga-qr
sudo install -d -m 700 /var/lib/siaga-qr

# 2. konfigurasi
cp .env.example .env && chmod 600 .env          # sesuaikan path bila perlu

# 3. jalankan + cek (sebelum nginx)
pm2 start deploy/ecosystem.config.cjs && pm2 save
curl -s 127.0.0.1:3021/api/siaga/v1/ready       # {"ok":true,"kid":"siaga-qr-2026-01"}

# 4. nginx: tambahkan isi deploy/nginx-siaga-qr.conf ke server block iot.get220v.com
sudo nginx -t && sudo systemctl reload nginx
curl -s https://iot.get220v.com/api/siaga/v1/health   # bukan lagi "No static resource"
```

**Secret yang harus disediakan operator:**
- `/etc/siaga-qr/private/<kid>.key`: private Ed25519, chmod 600.
- `/etc/siaga-qr/private/data.key`: 32 byte; **jangan pernah diganti** setelah ada label, karena nonce terenkripsi dengannya.
- `/etc/siaga-qr/public/*.pub`: semua public key, termasuk yang lama.

Backup kedua file private secara terenkripsi di luar server, dengan akses terbatas.

**Rollback:**
1. `npm run backup` (salinan konsisten DB) sebelum upgrade.
2. Rollback = `pm2 stop`, kembalikan rilis lama dan file backup DB, lalu `pm2 start`.

Migration bersifat additive, jadi rilis lama tetap bisa membaca DB baru selama tidak ada kolom
yang dihapus.

## Rotasi key

1. `node scripts/keygen.mjs --kid siaga-qr-2027-01 --out /etc/siaga-qr`. Ini menambah `.key` dan `.pub` baru; `data.key` lama tetap dipakai.
2. Di `.env`, set `SIAGA_QR_ACTIVE_KID` dan `SIAGA_QR_SIGNING_KEY_FILE` ke kid baru, lalu `pm2 restart get220v-siaga-qr`.
3. Label lama tetap terverifikasi lewat `public/siaga-qr-2026-01.pub`. **Jangan hapus `.pub` lama** sebelum semua labelnya expired atau dicabut.
4. Private key lama boleh dipindah ke arsip offline. Konsekuensinya: label lama tidak bisa di-export ulang (kolom `qr` kosong), tapi tetap valid. Untuk mencetak ulang, pakai reissue.

## Monitoring

`curl 127.0.0.1:3021/metrics` menyediakan:
- `siaga_qr_http_requests_total{route,status}` dan `siaga_qr_http_duration_ms_sum`,
- `siaga_qr_generated_total`, `siaga_qr_verified_total`, `siaga_qr_verify_rejected_total{reason}`, `siaga_qr_revoked_total`,
- `siaga_qr_active_key_info{kid}` dan `siaga_qr_jobs_running`.

Log PM2 berupa JSON per request (reqId, route, status, ms, userId), tanpa header atau body.

## Test

`npm test` (19 test, ThingsBoard tiruan + DB in-memory) mencakup acceptance 1–14 dari brief:
- role,
- tenant dan customer scope,
- tamper per byte,
- kid tidak dikenal, malformed, expired, iat di masa depan,
- device yang di-unassign,
- idempotency,
- generate paralel,
- revoke dan reissue,
- batch tanpa duplikat,
- audit immutable,
- log bersih,
- restart,
- rotasi key,
- fail-closed key.

Acceptance 15 (tenant uji di ThingsBoard asli) dijalankan di staging. Lihat bagian E2E di bawah.

### E2E di server (tenant/device dummy)

1. Login sebagai tenant admin dan ambil JWT.
2. Jalankan `generate` untuk satu device dummy, lalu `verify` (harus `valid:true`).
3. Jalankan `revoke`, lalu `verify` lagi (harus `410`, `REVOKED`).
4. Jalankan `reissue` pada label lain, lalu `verify` label lama (harus `410`, `REPLACED`) dan label baru (harus `valid:true`).
5. Ulangi `verify` dengan JWT customer user pemilik device (harus `valid:true`) dan customer lain (harus `403` generik).

## Batasan saat ini

- Export cetak berupa **CSV** (labelId, deviceName, siteId, expiresAt, qr). Aplikasi Android merender QR-nya. Export ZIP/PDF siap cetak belum dibuat, karena butuh library QR dan PDF.
- Job batch yang terputus karena restart ditandai `INTERRUPTED`. Jalankan ulang batch yang sama dengan `onlyWithoutActiveLabel=true`; hasilnya aman, tanpa duplikat. Job memakai JWT admin, jadi job yang berjalan lebih lama dari umur token (sekitar 2,5 jam) akan gagal per item.
- Satu proses (PM2 fork, 1 instance). Untuk lebih dari satu instance, link export dan job perlu pindah ke DB atau Redis, dan SQLite diganti PostgreSQL.
- `siteId` diambil dari server attribute `siteId`, atau `building` bila `siteId` tidak ada.
