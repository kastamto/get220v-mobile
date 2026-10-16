import { loadConfig, loadDotEnv } from './config.js';
import { createApp } from './server.js';

loadDotEnv();
const config = loadConfig();
const { server } = createApp(config);

server.listen(config.port, config.host, () => {
  console.log(
    `[embed] get220v-dashboard-embed listen ${config.host}:${config.port} ` +
      `(TB ${config.tbInternalUrl}, ${config.apps.length} app: ${config.apps.map((a) => `${a.id}/${a.mode}`).join(', ')})`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
