# Widget "API Key Manager" untuk ThingsBoard

Widget ini menampilkan halaman `/building-api/admin` di dalam dashboard ThingsBoard, sehingga
tenant admin bisa membuat, mengubah, merotasi, menonaktifkan, dan menghapus API key aplikasi luar
langsung dari web TB.

## Pasang cepat: import JSON (disarankan)

1. **Resources → Widgets library → tab Widgets → + → Import widget**, pilih
   `api_key_manager.widget.json`, lalu Import.
2. **Dashboards → + → Import dashboard**, pilih `api_keys.dashboard.json`, lalu Import.
   Dashboard ini memakai widget `tenant.api_key_manager`, jadi langkah 1 harus selesai dulu.
3. Buka dashboard **API Keys**. Jangan assign dashboard ini ke customer.

## Pasang manual (alternatif)

1. Login ke `https://iot.get220v.com` sebagai **tenant admin**.
2. **Resources → Widgets library → Widgets bundles**. Buat bundle baru, mis. `Get220v Admin`, lalu buka.
3. Klik **+ → Create new widget type** dan pilih **Static widget**.
4. Isi tiga tab editor dari file di folder ini:
   - **HTML** ← `template.html`
   - **CSS** ← `template.css`
   - **JavaScript** ← `controller.js`
5. Simpan dengan nama `API Key Manager`.
6. **Dashboards → +** buat dashboard `API Keys`, tambahkan widget `API Key Manager`, lalu perbesar
   ukurannya (mis. 24 × 12 kolom).
7. **Jangan assign dashboard ini ke customer mana pun.** Pengguna non-tenant-admin yang membukanya
   tetap ditolak gateway (403), tapi dashboard ini memang hanya untuk admin.

Cara cepat tanpa widget custom: tambahkan widget bawaan yang bisa menampilkan iframe, atau buka
`https://iot.get220v.com/building-api/admin` langsung di tab browser yang sudah login ke TB.

## Cara kerja & keamanan

- Halaman membaca token login TB dari browser (origin yang sama) dan mengirimnya ke gateway.
  Gateway memeriksa token itu ke ThingsBoard (`/api/auth/user`) dan hanya menerima
  **TENANT_ADMIN dari tenant yang sama** dengan akun service gateway.
- Client disimpan di TB sebagai asset type `api-client` (nama `apiclient-<id>`), dengan attribute
  `keySha256`, `keyHint`, `buildings`, `scopes`, `rpcMethods`, `embedUserId`, `enabled`,
  `createdBy`, `updatedBy`. **Key asli tidak pernah disimpan.** Key hanya ditampilkan sekali saat
  dibuat atau dirotasi.
- Perubahan berlaku ≤ 30 detik (`CLIENT_CACHE_SEC`) tanpa restart. Perubahan dari halaman ini sendiri
  berlaku langsung.
- Halaman hanya bisa di-iframe oleh origin yang sama (`frame-ancestors 'self'`).
- Setiap aksi tercatat di log gateway: `pm2 logs get220v-building-gateway | grep '\[admin\]'`.
- Client di `clients.json` (termasuk yang punya webhook) tetap jalan dan tampil sebagai
  "dikelola di server". Ubah mereka di file seperti sebelumnya.
