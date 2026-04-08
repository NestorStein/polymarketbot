'use strict';

module.exports = {
  apps: [
    {
      name:    'polymarket-bot',
      script:  './index.js',
      cwd:     __dirname,

      // ── Restart policy ──────────────────────────────────────────────────────
      // Exponential backoff: 100ms → 200ms → 400ms … capped at 60s.
      // Prevents a crash-loop from hammering the CLOB or placing runaway orders.
      exp_backoff_restart_delay: 100,

      // If the process crashes within 10s of starting, count it as an unstable
      // restart. After max_restarts unstable restarts, PM2 stops trying.
      min_uptime:    '10s',
      max_restarts:  10,

      // Kill switch for runaway memory — catches leaks before they degrade performance.
      max_memory_restart: '512M',

      // Never restart on file changes — a file save during a live trade is dangerous.
      watch: false,

      // ── Logging ─────────────────────────────────────────────────────────────
      // Merge stdout + stderr into one stream so grep works on a single file.
      merge_logs:   true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // ── Environment ─────────────────────────────────────────────────────────
      env: {
        NODE_ENV:          'production',
        ORACLE_LAG_ONLY:   'true',
      },
    },

    {
      name:   'bot-monitor',
      script: './auto_monitor.js',
      cwd:    __dirname,
      exp_backoff_restart_delay: 1000,
      min_uptime:   '30s',
      max_restarts: 5,
      max_memory_restart: '128M',
      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
