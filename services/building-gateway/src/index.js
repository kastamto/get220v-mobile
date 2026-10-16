import { loadConfig, loadDotEnv } from './config.js';
import { createGatewayServer } from './server.js';

loadDotEnv();
const config = loadConfig();
if (typeof globalThis.WebSocket !== 'function') {
  console.error('[gw] butuh Node >= 22 (WebSocket global) untuk realtime/webhook telemetry');
}
const { server, webhooks } = createGatewayServer(config);

server.listen(config.port, config.host, () => {
  console.log(
    `[gw] get220v-building-gateway listen ${config.host}:${config.port} ` +
      `(TB ${config.tbInternalUrl}, building type "${config.buildingAssetType}", relation "${config.relationType}", ` +
      `${config.clients.length} client, ${webhooks.targets.length} webhook)`,
  );
  webhooks.start().catch((e) => console.error('[gw] webhook start gagal:', e.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
