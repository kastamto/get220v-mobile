// pm2 start deploy/ecosystem.config.cjs   (dari /opt/get220v/get220v-building-gateway)
module.exports = {
  apps: [
    {
      name: 'get220v-building-gateway',
      script: 'src/index.js',
      cwd: __dirname + '/..',
      // ticket embed, stream SSE & state webhook in-memory -> WAJIB 1 instance
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
