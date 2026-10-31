import { loadConfig, loadDotEnv } from './config.js';
import { openDb } from './db.js';
import { KeyRing } from './keys.js';
import { createQrServer } from './server.js';

loadDotEnv();
let config;
let keys;
let db;
try {
  config = loadConfig();
  // fail closed: tanpa signing key valid service tidak start (tidak ada QR tanpa tanda tangan)
  keys = KeyRing.load(config);
  db = openDb(config.dbPath);
} catch (e) {
  console.error(`[siaga-qr] gagal start: ${e.message}`);
  process.exit(1);
}
const { server } = createQrServer(config, { db, keys });
server.listen(config.port, config.host, () => {
  console.log(`[siaga-qr] listen ${config.host}:${config.port} · kid aktif ${keys.activeKid} · verifikasi ${keys.kids.join(', ')} · db ${config.dbPath}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
}
