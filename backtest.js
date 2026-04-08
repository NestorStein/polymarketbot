'use strict';

/**
 * Oracle Lag Arb — Approximate Backtest (Binance-only)
 *
 * Why Binance-only (no Polymarket API):
 *   Polymarket removes 5m resolved markets from its API immediately after
 *   they close — slug lookups return NOT FOUND for anything >5 min old.
 *
 *   Instead: Binance 1m klines serve as BOTH the signal input AND the
 *   resolution proxy. The market outcome is "did price end UP or DOWN vs
 *   the 5-min window open price?" — which matches Chainlink resolution
 *   with ~95%+ accuracy on strong moves (Binance is a primary Chainlink
 *   price source for BTC/ETH/DOGE).
 *
 * What is measured:
 *   • Win rate: does the Binance move at 2-4 min predict direction at 5 min?
 *   • Signal frequency across assets and hours
 *   • Anti-bounce filter effectiveness
 *   • Estimated P&L at various CLOB entry price assumptions
 *
 * What is NOT measured:
 *   • PATH C (REVERSAL) — requires historical CLOB data
 *   • Whether the CLOB was actually stale at signal time
 *   • Exact fill price (assumed scenarios)
 *
 * Usage:
 *   node backtest.js [--days=30] [--asset=btc,eth,doge]
 */

const axios = require('axios');

// ── CLI args ───────────────────────────────────────────────────────────────────
const DAYS_BACK = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '30');
const ASSET_ARG = process.argv.find(a => a.startsWith('--asset='))?.split('=')[1];
const ASSETS    = ASSET_ARG ? ASSET_ARG.split(',') : ['btc', 'eth', 'doge'];
const BINANCE_SYMBOLS = { btc: 'BTCUSDT', eth: 'ETHUSDT', doge: 'DOGEUSDT' };

// ── Signal thresholds — exact match to live oracleLagArb.js ───────────────────
const WINDOW_MIN_PCT     = 0.55;   // PATH B: |pctWindow| ≥ 0.55%
const SPIKE60_MIN_PCT    = 0.12;   // PATH B: |spike60| ≥ 0.12%
const SPIKE_MIN_PCT      = 0.20;   // PATH A: |spike60| ≥ 0.20% (disabled live)
const SPIKE_WINDOW_MIN   = 0.20;   // PATH A: |pctWindow| ≥ 0.20%
const ANTI_BOUNCE_THRESH = 0.12;   // priorCtx must not oppose by > 0.12%
const NET_TREND_THRESH   = 0.15;   // netTrend8m must not oppose by > 0.15%

// ── P&L estimation ────────────────────────────────────────────────────────────
const CLOB_SCENARIOS = [0.29, 0.31, 0.33, 0.35, 0.37];
const BET_SIZE       = 20;    // USDC per trade (assumed)
const FEE_RATE       = 0.02;  // ~2% fee on payout

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pnl(won, clobPrice) {
  // Win: buy (BET_SIZE / clobPrice) shares, each pays $1, fee on payout
  // Lose: forfeit BET_SIZE
  return won
    ? (BET_SIZE / clobPrice) * (1 - FEE_RATE) - BET_SIZE
    : -BET_SIZE;
}

// ── Binance kline fetcher ──────────────────────────────────────────────────────
async function fetchAllKlines(symbol, startMs, endMs) {
  const klines = [];
  let from = startMs;
  process.stdout.write(`  ${symbol}: `);
  while (from < endMs) {
    const res = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol, interval: '1m', startTime: from, endTime: endMs, limit: 1000 },
      timeout: 15000,
    });
    if (!res.data?.length) break;
    klines.push(...res.data);
    from = Number(res.data[res.data.length - 1][0]) + 60000;
    if (res.data.length < 1000) break;
    process.stdout.write('.');
    await sleep(120);
  }
  console.log(` ${klines.length} candles`);
  // Build map: openTime(ms) → kline
  const map = new Map();
  for (const k of klines) map.set(Number(k[0]), k);
  return map;
}

// ── Signal simulation (per 5-min window) ──────────────────────────────────────
// Returns: { path, direction, won, ... } or null (no signal fired)
function simulateWindow(windowStartMs, klineMap) {
  // Window open price = close of the candle BEFORE the window starts
  const prior = klineMap.get(windowStartMs - 60000);
  if (!prior) return null;
  const windowOpen = parseFloat(prior[4]);

  // Resolution proxy: is the 5-min close UP or DOWN vs window open?
  // We use the candle at windowStartMs + 240000 (4-min mark) close,
  // or +300000 (the candle AFTER the window) — the last candle of the window.
  // Actually: the window runs from windowStartMs to windowStartMs+300000.
  // The 5-min candle at windowStartMs+240000 closes at windowStartMs+300000.
  // We use the close of that candle as our resolution proxy.
  const resolutionCandle = klineMap.get(windowStartMs + 240000);
  if (!resolutionCandle) return null;
  const resolutionPrice = parseFloat(resolutionCandle[4]);
  const resolutionMove  = ((resolutionPrice - windowOpen) / windowOpen) * 100;

  // Skip near-zero outcome windows (price basically flat at end = coin flip)
  if (Math.abs(resolutionMove) < 0.03) return null;

  const resolution = resolutionMove > 0 ? 'UP' : 'DOWN';

  // Check each 1m candle after 90s have elapsed in the window
  // Valid check times: 2-min, 3-min, 4-min marks (i.e. 120s, 180s, 240s from window start)
  const checkTimes = [
    windowStartMs + 120000,
    windowStartMs + 180000,
    windowStartMs + 240000,
  ];

  for (const ts of checkTimes) {
    const candle = klineMap.get(ts);
    if (!candle) continue;
    const curPrice = parseFloat(candle[4]);

    // Signal metrics
    const pctWindow = ((curPrice - windowOpen) / windowOpen) * 100;

    const c1m = klineMap.get(ts - 60000);
    if (!c1m) continue;
    const spike60 = ((curPrice - parseFloat(c1m[4])) / parseFloat(c1m[4])) * 100;

    const c8m = klineMap.get(ts - 8 * 60000);
    const c2m = klineMap.get(ts - 2 * 60000);
    const move8m = c8m ? ((curPrice - parseFloat(c8m[4])) / parseFloat(c8m[4])) * 100 : null;
    const move2m = c2m ? ((curPrice - parseFloat(c2m[4])) / parseFloat(c2m[4])) * 100 : null;

    const priorContext = (move8m !== null && move2m !== null) ? move8m - move2m : null;
    const netTrend8m  = move8m;
    const spikeDir60  = (pctWindow > 0 && spike60 > 0) || (pctWindow < 0 && spike60 < 0);

    // Anti-bounce
    const trendOpposes = netTrend8m !== null && (
      spike60 > 0 ? netTrend8m < -NET_TREND_THRESH : netTrend8m > NET_TREND_THRESH
    );
    const antiBouncePasses = priorContext === null
      ? !trendOpposes
      : (spike60 > 0 ? priorContext >= -ANTI_BOUNCE_THRESH : priorContext <= ANTI_BOUNCE_THRESH) && !trendOpposes;

    const isWindow = Math.abs(pctWindow) >= WINDOW_MIN_PCT && Math.abs(spike60) >= SPIKE60_MIN_PCT && spikeDir60 && antiBouncePasses;
    const isSpike  = Math.abs(spike60) >= SPIKE_MIN_PCT && Math.abs(pctWindow) >= SPIKE_WINDOW_MIN && spikeDir60 && antiBouncePasses;
    // Would fire without filter
    const wouldFireRaw = (
      (Math.abs(pctWindow) >= WINDOW_MIN_PCT && Math.abs(spike60) >= SPIKE60_MIN_PCT && spikeDir60) ||
      (Math.abs(spike60) >= SPIKE_MIN_PCT && Math.abs(pctWindow) >= SPIKE_WINDOW_MIN && spikeDir60)
    );

    if (!isWindow && !isSpike && !wouldFireRaw) continue;

    const direction     = pctWindow > 0 ? 'UP' : 'DOWN';
    const won           = direction === resolution;
    const blockedByFilter = !antiBouncePasses && wouldFireRaw;

    return {
      windowStart: windowStartMs,
      ts,
      minuteInWindow: (ts - windowStartMs) / 60000,
      direction,
      pctWindow,
      spike60,
      priorContext,
      netTrend8m,
      antiBouncePasses,
      isWindow,
      isSpike,
      blockedByFilter,
      resolution,
      resolutionMove,
      won,
      utcHour: new Date(ts).getUTCHours(),
    };
  }

  return null;
}

// ── Reporting helpers ──────────────────────────────────────────────────────────
function reportGroup(label, signals) {
  if (!signals.length) { console.log(`\n${label}\n  No signals.`); return; }

  const wins   = signals.filter(s => s.won).length;
  const n      = signals.length;
  const wr     = (wins / n * 100).toFixed(1);
  const avgW   = (signals.reduce((a, s) => a + Math.abs(s.pctWindow), 0) / n).toFixed(3);
  const avgS   = (signals.reduce((a, s) => a + Math.abs(s.spike60),  0) / n).toFixed(3);
  const avgRes = (signals.reduce((a, s) => a + Math.abs(s.resolutionMove), 0) / n).toFixed(3);

  console.log(`\n${label}`);
  console.log(`  ${'─'.repeat(56)}`);
  console.log(`  Signals: ${n}  |  ${wins}W / ${n - wins}L  |  Win rate: ${wr}%`);
  console.log(`  Avg |window@entry|: ${avgW}%  |  Avg |spike60|: ${avgS}%  |  Avg |resolution move|: ${avgRes}%`);

  // By asset
  for (const asset of ASSETS) {
    const sub = signals.filter(s => s.asset === asset);
    if (!sub.length) continue;
    const w  = sub.filter(s => s.won).length;
    const wr2 = (w / sub.length * 100).toFixed(1);
    const est = sub.reduce((a, s) => a + pnl(s.won, 0.33), 0);
    console.log(`    ${asset.toUpperCase().padEnd(5)}  ${String(sub.length).padStart(4)} signals  ${w}W/${sub.length - w}L  ${wr2.padStart(5)}% WR  | P&L @0.33: ${est >= 0 ? '+' : ''}$${est.toFixed(2)}`);
  }

  // P&L scenarios
  console.log(`\n  P&L by assumed CLOB entry price (bet=$${BET_SIZE}, fee=${(FEE_RATE * 100).toFixed(0)}%):`);
  console.log(`  ${'CLOB'.padEnd(8)} ${'Total P&L'.padEnd(14)} ${'EV/trade'.padEnd(12)} ${'Breakeven WR'.padEnd(14)} Status`);
  console.log(`  ${'─'.repeat(58)}`);
  for (const clob of CLOB_SCENARIOS) {
    const total = signals.reduce((a, s) => a + pnl(s.won, clob), 0);
    const ev    = total / n;
    // p = clob / (1 - fee) is breakeven win rate
    const beWr  = (clob / (1 - FEE_RATE) * 100).toFixed(1);
    const flag  = parseFloat(wr) > parseFloat(beWr) ? '✓ EDGE' : '✗ LOSS';
    console.log(
      `  ${String(clob).padEnd(8)}` +
      ` ${((total >= 0 ? '+' : '') + '$' + total.toFixed(2)).padEnd(14)}` +
      ` ${((ev >= 0 ? '+' : '') + '$' + ev.toFixed(2)).padEnd(12)}` +
      ` ${(beWr + '%').padEnd(14)}` +
      ` ${flag}`
    );
  }
}

function reportHourly(signals) {
  if (!signals.length) return;
  const byHour = {};
  for (const s of signals) {
    if (!byHour[s.utcHour]) byHour[s.utcHour] = { wins: 0, n: 0 };
    byHour[s.utcHour].n++;
    if (s.won) byHour[s.utcHour].wins++;
  }
  console.log('\nPATH B (WINDOW) signal distribution by UTC hour:');
  console.log('  (hour = signal fire time)');
  for (let h = 0; h < 24; h++) {
    const d = byHour[h];
    if (!d || d.n === 0) continue;
    const wr    = (d.wins / d.n * 100).toFixed(0);
    const bar   = '█'.repeat(Math.min(d.n, 25));
    const blank = '░'.repeat(Math.max(0, 25 - d.n));
    console.log(`  ${String(h).padStart(2, '0')}h: ${String(d.wins).padStart(2)}W/${String(d.n - d.wins).padStart(2)}L (${String(wr).padStart(3)}%) ${bar}${blank} ${d.n}`);
  }
}

function reportByMoveSize(signals) {
  if (!signals.length) return;
  const buckets = [
    { label: '0.55-0.70%', min: 0.55, max: 0.70 },
    { label: '0.70-0.90%', min: 0.70, max: 0.90 },
    { label: '0.90-1.20%', min: 0.90, max: 1.20 },
    { label: '>1.20%',     min: 1.20, max: Infinity },
  ];
  console.log('\nPATH B (WINDOW) win rate by |pctWindow| at signal:');
  console.log(`  ${'Window'.padEnd(12)} ${'N'.padEnd(5)} ${'Wins'.padEnd(6)} ${'WR%'.padEnd(8)} P&L @0.33`);
  console.log(`  ${'─'.repeat(45)}`);
  for (const { label, min, max } of buckets) {
    const sub = signals.filter(s => Math.abs(s.pctWindow) >= min && Math.abs(s.pctWindow) < max);
    if (!sub.length) continue;
    const w  = sub.filter(s => s.won).length;
    const wr = (w / sub.length * 100).toFixed(1);
    const est = sub.reduce((a, s) => a + pnl(s.won, 0.33), 0);
    console.log(`  ${label.padEnd(12)} ${String(sub.length).padEnd(5)} ${String(w).padEnd(6)} ${(wr + '%').padEnd(8)} ${(est >= 0 ? '+' : '') + '$' + est.toFixed(2)}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const nowMs   = Date.now();
  const startMs = nowMs - DAYS_BACK * 24 * 60 * 60 * 1000;

  console.log('\n' + '='.repeat(62));
  console.log('Oracle Lag Arb — Backtest (Binance Price Direction)');
  console.log('='.repeat(62));
  console.log(`Period : ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(nowMs).toISOString().slice(0, 10)}`);
  console.log(`Assets : ${ASSETS.map(a => a.toUpperCase()).join(', ')}`);
  console.log(`Days   : ${DAYS_BACK}`);
  console.log('Method : 1m klines — signal at 2-4 min mark, resolution at 5 min close');
  console.log('Note   : Resolution is Binance direction proxy, not actual Chainlink value');

  // ── Step 1: Fetch klines ──────────────────────────────────────────────────
  console.log('\n[1/2] Fetching Binance 1m klines...');
  const klineMaps = {};
  for (const asset of ASSETS) {
    // Extra 15 min before start for anti-bounce lookback (move8m needs 8 min of history)
    klineMaps[asset] = await fetchAllKlines(BINANCE_SYMBOLS[asset], startMs - 15 * 60 * 1000, nowMs);
    await sleep(300);
  }

  // ── Step 2: Enumerate all 5-min windows and simulate ─────────────────────
  console.log('\n[2/2] Simulating every 5-min window...');

  const windowSignals  = []; // PATH B (live)
  const spikeSignals   = []; // PATH A (disabled)
  const blockedSignals = []; // Would fire but blocked by anti-bounce filter

  let totalWindows = 0;

  for (const asset of ASSETS) {
    const klineMap = klineMaps[asset];
    // All 5-min window start times in the range
    const firstWindow = Math.ceil(startMs / 300000) * 300000;
    let windowed = 0;

    for (let winMs = firstWindow; winMs < nowMs - 300000; winMs += 300000) {
      totalWindows++;
      windowed++;
      const result = simulateWindow(winMs, klineMap);
      if (!result) continue;
      result.asset = asset;

      if (result.blockedByFilter) blockedSignals.push(result);
      else if (result.isWindow)   windowSignals.push(result);
      else if (result.isSpike)    spikeSignals.push(result);
    }
    console.log(`  ${asset.toUpperCase()}: ${windowed} windows, ${windowSignals.filter(s => s.asset === asset).length} WINDOW, ${spikeSignals.filter(s => s.asset === asset).length} SPIKE, ${blockedSignals.filter(s => s.asset === asset).length} BLOCKED`);
  }

  // ── Results ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(62));
  console.log('RESULTS');
  console.log('='.repeat(62));
  console.log(`Total windows simulated : ${totalWindows}`);
  console.log(`PATH B (WINDOW) signals : ${windowSignals.length} (${(windowSignals.length / totalWindows * 100).toFixed(2)}% of windows)`);
  console.log(`PATH A (SPIKE)  signals : ${spikeSignals.length}  (disabled live)`);
  console.log(`Anti-bounce blocked     : ${blockedSignals.length}`);

  reportGroup('PATH B (WINDOW) — |pctWindow|≥0.55% + |spike60|≥0.12%  [LIVE]', windowSignals);
  reportGroup('PATH A (SPIKE)  — |spike60|≥0.20% + |window|≥0.20%     [DISABLED]', spikeSignals);

  // Anti-bounce filter effectiveness
  const totalCandidates = windowSignals.length + spikeSignals.length + blockedSignals.length;
  if (blockedSignals.length > 0 && totalCandidates > 0) {
    const wouldWin  = blockedSignals.filter(s => s.direction === s.resolution).length;
    const wouldLose = blockedSignals.length - wouldWin;
    const blockedWR = (wouldWin / blockedSignals.length * 100).toFixed(1);
    const saved     = wouldLose * BET_SIZE;                       // losses saved
    const cost      = wouldWin * pnl(true, 0.33);                // wins missed
    const netImpact = saved - cost;
    console.log(`\nANTI-BOUNCE FILTER EFFECTIVENESS (${DAYS_BACK}d):`);
    console.log(`  Candidates (before filter) : ${totalCandidates}`);
    console.log(`  Blocked                    : ${blockedSignals.length} (${(blockedSignals.length / totalCandidates * 100).toFixed(1)}%)`);
    console.log(`  Blocked WR (would-have-won): ${wouldWin}/${blockedSignals.length} = ${blockedWR}%`);
    console.log(`  Net P&L impact @CLOB=0.33  : ${netImpact >= 0 ? '+' : ''}$${netImpact.toFixed(2)} (saved ${wouldLose} losses, blocked ${wouldWin} wins)`);
  }

  reportByMoveSize(windowSignals);
  reportHourly(windowSignals);

  // Projected daily trade rate
  const signalsPerDay = windowSignals.length / DAYS_BACK;
  console.log(`\nPROJECTED RATES (PATH B, WINDOW):`);
  console.log(`  Signals/day   : ${signalsPerDay.toFixed(1)}`);
  console.log(`  Signals/week  : ${(signalsPerDay * 7).toFixed(0)}`);
  if (windowSignals.length > 0) {
    const totalPnl33 = windowSignals.reduce((a, s) => a + pnl(s.won, 0.33), 0);
    console.log(`  Est P&L/day @0.33 : ${(totalPnl33 / DAYS_BACK >= 0 ? '+' : '') + '$' + (totalPnl33 / DAYS_BACK).toFixed(2)}`);
    console.log(`  Est P&L/week @0.33: ${(totalPnl33 / DAYS_BACK * 7 >= 0 ? '+' : '') + '$' + (totalPnl33 / DAYS_BACK * 7).toFixed(2)}`);
  }

  console.log('\n' + '='.repeat(62));
  console.log('LIMITATIONS');
  console.log('='.repeat(62));
  console.log('  ⚠  Resolution is Binance direction at 5-min close, not Chainlink.');
  console.log('     For clear moves (>0.1%) accuracy is ~95%+. Flat windows excluded.');
  console.log('  ⚠  CLOB prices assumed — actual entry price varies by market liquidity.');
  console.log('  ⚠  PATH C (REVERSAL) excluded — requires historical CLOB order book.');
  console.log('  ⚠  Real trades require CLOB to still be stale at signal time.');
  console.log('     In some windows the CLOB reprices before we get a fill.');
  console.log('  ⚠  1m klines approximate the 55s aggTrade stream (slightly coarser).');
  console.log('');
}

main().catch(err => { console.error('\nBacktest error:', err.message); process.exit(1); });
