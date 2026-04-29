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

  // Telegram command polling
  const tg = require('./src/telegram');
  tg.startPolling(async (cmd) => {
    if (cmd === '/report')    { tg.send(await engine.buildReport());    return; }
    if (cmd === '/monitor')   { tg.send(engine.buildMonitor());         return; }
    if (cmd === '/positions') { tg.send(await engine.buildPositions()); return; }
    if (cmd === '/balance') {
      const bal = engine.oracleLag?._cachedBalance ?? 0;
      tg.send(`💰 Balance: $${bal.toFixed(2)}`);
      return;
    }
    if (cmd === '/pause') {
      if (engine.oracleLag) engine.oracleLag.paused = true;
      tg.send('⏸ Bot paused — no new trades will be placed.');
      return;
    }
    if (cmd === '/resume') {
      if (engine.oracleLag) engine.oracleLag.paused = false;
      tg.send('▶️ Bot resumed — scanning for opportunities.');
      return;
    }
    if (cmd === '/help') {
      tg.send(
        '🤖 <b>Bot commands</b>\n' +
        '/monitor   — live prices, window moves, recent signals\n' +
        '/positions — open positions &amp; wins ready to redeem\n' +
        '/report    — daily P&amp;L, last 5 bets, latency\n' +
        '/balance   — current USDC balance\n' +
        '/pause     — pause trading (keeps scanning)\n' +
        '/resume    — resume trading\n' +
        '/help      — this message\n\n' +
        '🔔 <b>Auto alerts</b>\n' +
        '• Trade fired\n' +
        '• Near miss (CLOB just above threshold)\n' +
        '• Position settled (WIN/LOSS)\n' +
        '• Daily summary at midnight'
      );
      return;
    }
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
