'use strict';

// Starts ONLY the dashboard UI server — no trading, no wallet, no WebSockets to exchanges.
const { loadConfig } = require('./src/config');
const { Dashboard }  = require('./src/dashboard');

async function main() {
  let config;
  try { config = loadConfig(); } catch (err) {
    console.error('[Config]', err.message);
    process.exit(1);
  }

  const dashboard = new Dashboard(config);
  dashboard.state.status = 'STOPPED';
  await dashboard.listen();

  console.log('[UI] Dashboard running — bot is NOT started.');
  console.log('[UI] Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    console.log('\n[UI] Shutting down...');
    process.exit(0);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
