'use strict';

const { loadConfig }     = require('./src/config');
const { Dashboard }      = require('./src/dashboard');
const { StrategyEngine } = require('./src/strategyEngine');

const BANNER = `
██████╗  ██████╗ ██╗  ██╗   ██████╗  ██████╗ ████████╗
██╔══██╗██╔═══██╗██║  ╚██╗  ██╔══██╗██╔═══██╗╚══██╔══╝
██████╔╝██║   ██║██║   ██║  ██████╔╝██║   ██║   ██║
██╔═══╝ ██║   ██║██║  ╚██╗  ██╔══██╗██║   ██║   ██║
██║     ╚██████╔╝███████╔╝  ██████╔╝╚██████╔╝   ██║
╚═╝      ╚═════╝ ╚══════╝   ╚═════╝  ╚═════╝    ╚═╝
Polymarket Multi-Signal Bot — signals: news + twitter + cross-platform + price
`;

async function main() {
  console.log(BANNER);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[Config]', err.message);
    process.exit(1);
  }

  const dashboard = new Dashboard(config);
  await dashboard.listen();

  const engine = new StrategyEngine(config, dashboard);

  // Emergency stop from dashboard
  dashboard.on('emergency_stop', () => {
    console.log('\n⚠  EMERGENCY STOP from dashboard\n');
    engine.stop();
    dashboard.stopped();
    process.exit(0);
  });

  // Pause / resume trading from dashboard button
  dashboard.on('bot_pause',  () => { engine.pause();  console.log('[Bot] Trading paused'); });
  dashboard.on('bot_resume', () => { engine.resume(); console.log('[Bot] Trading resumed'); });

  // Relay crypto prices to dashboard
  engine.signals.priceFeed.on('price', () => {
    dashboard.cryptoPriceUpdate(engine.signals.priceFeed.getCurrentPrices());
  });

  // Stats broadcast every 15s (with real balance fetch)
  setInterval(async () => {
    const stats = engine.getStats();
    dashboard.scanUpdate(stats.scanCount);
    const balance = await engine.poly.getBalance().catch(() => null);
    if (balance !== null) {
      dashboard.balanceUpdate(balance, stats);
    }
  }, 15000);

  // Graceful shutdown
  function shutdown() {
    console.log('\nShutting down...');
    engine.stop();
    dashboard.stopped();
    dashboard.close();
    setTimeout(() => process.exit(0), 1000);
  }
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  const ok = await engine.start();
  if (!ok) {
    console.error('Engine failed to start. Set POLYGON_PRIVATE_KEY in .env');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
