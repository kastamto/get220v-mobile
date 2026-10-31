// pm2 start deploy/ecosystem.config.cjs   (dari /opt/get220v/get220v-siaga-qr)
// Butuh Node >= 22.13 (node:sqlite). Bila node sistem lebih lama, set `interpreter`
// ke binary Node 22 (mis. /opt/nodejs/node22/bin/node) di salinan server, jangan di repo.
module.exports = {
  apps: [
    {
      name: 'get220v-siaga-qr',
      script: 'src/index.js',
      cwd: __dirname + '/..',
      node_args: '--disable-warning=ExperimentalWarning',
      // job batch & link export ada di memori proses -> WAJIB 1 instance
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
