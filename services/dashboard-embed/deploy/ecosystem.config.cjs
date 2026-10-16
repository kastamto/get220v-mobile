// pm2 start deploy/ecosystem.config.cjs   (jalankan dari /opt/get220v/get220v-dashboard-embed)
module.exports = {
  apps: [
    {
      name: 'get220v-dashboard-embed',
      script: 'src/index.js',
      cwd: __dirname + '/..',
      // ticket disimpan in-memory -> WAJIB 1 instance (jangan cluster mode)
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
