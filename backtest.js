'use strict';

/**
 * Oracle Lag Arb — Comprehensive Backtest
 *
 * Usage:
 *   node backtest.js [--days=90] [--asset=btc,eth,doge]
 */

const axios = require('axios');

// ── CLI args ───────────────────────────────────────────────────────────────────
const DAYS_BACK = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '90');
const ASSET_ARG = process.argv.find(a => a.startsWith('--asset='))?.split('=')[1];
const ASSETS    = ASSET_ARG ? ASSET_ARG.split(',') : ['btc', 'eth', 'doge'];
const BINANCE_SYMBOLS = { btc: 'BTCUSDT', eth: 'ETHUSDT', doge: 'DOGEUSDT' };

// ── Signal thresholds — exact match to live oracleLagArb.js ───────────────────
const WINDOW_MIN_PCT     = 0.70;
const SPIKE60_MIN_PCT    = 0.20;
const SPIKE_MIN_PCT      = 0.20;
const SPIKE_WINDOW_MIN   = 0.20;
const ANTI_BOUNCE_THRESH = 0.25;
const NET_TREND_THRESH   = 0.15;

// ── P&L / sizing ──────────────────────────────────────────────────────────────
const CLOB_SCENARIOS = [0.29, 0.31, 0.33, 0.35, 0.37];
const BET_SIZE       = 20;
const FEE_RATE       = 0.02;
// Fill-rate scenarios: fraction of signals that actually get a stale CLOB fill
const FILL_RATES     = [1.0, 0.80, 0.60, 0.40];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tradePnl(won, clobPrice) {
  return won ? (BET_SIZE / clobPrice) * (1 - FEE_RATE) - BET_SIZE : -BET_SIZE;
}

// ── Binance kline fetcher ──────────────────────────────────────────────────────
async function fetchAllKlines(symbol, startMs, endMs) {
  const klines = [];
  let from = startMs;
  process.stdout.write(`  ${symbol}: `);
  while (from < endMs) {
    const res = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol, interval: '1m', startTime: from, endTime: endMs, limit: 1000 },
      timeout: 20000,
    });
    if (!res.data?.length) break;
    klines.push(...res.data);
    from = Number(res.data[res.data.length - 1][0]) + 60000;
    if (res.data.length < 1000) break;
    process.stdout.write('.');
    await sleep(120);
  }
  console.log(` ${klines.length} candles`);
  const map = new Map();
  for (const k of klines) map.set(Number(k[0]), k);
  return map;
}

// ── Signal simulation ──────────────────────────────────────────────────────────
function simulateWindow(windowStartMs, klineMap) {
  const prior = klineMap.get(windowStartMs - 60000);
  if (!prior) return null;
  const windowOpen = parseFloat(prior[4]);

  const resolutionCandle = klineMap.get(windowStartMs + 240000);
  if (!resolutionCandle) return null;
  const resolutionPrice = parseFloat(resolutionCandle[4]);
  const resolutionMove  = ((resolutionPrice - windowOpen) / windowOpen) * 100;
  if (Math.abs(resolutionMove) < 0.03) return null;
  const resolution = resolutionMove > 0 ? 'UP' : 'DOWN';

  const checkTimes = [
    windowStartMs + 120000,
    windowStartMs + 180000,
    windowStartMs + 240000,
  ];

  for (const ts of checkTimes) {
    const candle = klineMap.get(ts);
    if (!candle) continue;
    const curPrice = parseFloat(candle[4]);
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

    const trendOpposes = netTrend8m !== null && (
      spike60 > 0 ? netTrend8m < -NET_TREND_THRESH : netTrend8m > NET_TREND_THRESH
    );
    const antiBouncePasses = priorContext === null
      ? !trendOpposes
      : (spike60 > 0 ? priorContext >= -ANTI_BOUNCE_THRESH : priorContext <= ANTI_BOUNCE_THRESH) && !trendOpposes;

    const isWindow    = Math.abs(pctWindow) >= WINDOW_MIN_PCT && Math.abs(spike60) >= SPIKE60_MIN_PCT && spikeDir60 && antiBouncePasses;
    const isSpike     = Math.abs(spike60) >= SPIKE_MIN_PCT    && Math.abs(pctWindow) >= SPIKE_WINDOW_MIN && spikeDir60 && antiBouncePasses;
    const wouldFireRaw = (
      (Math.abs(pctWindow) >= WINDOW_MIN_PCT && Math.abs(spike60) >= SPIKE60_MIN_PCT && spikeDir60) ||
      (Math.abs(spike60)   >= SPIKE_MIN_PCT  && Math.abs(pctWindow) >= SPIKE_WINDOW_MIN && spikeDir60)
    );

    if (!isWindow && !isSpike && !wouldFireRaw) continue;

    const direction      = pctWindow > 0 ? 'UP' : 'DOWN';
    const won            = direction === resolution;
    const blockedByFilter = !antiBouncePasses && wouldFireRaw;
    const date           = new Date(ts);

    return {
      windowStart: windowStartMs, ts,
      minuteInWindow: (ts - windowStartMs) / 60000,
      direction, pctWindow, spike60, priorContext, netTrend8m,
      antiBouncePasses, isWindow, isSpike, blockedByFilter,
      resolution, resolutionMove, won,
      utcHour: date.getUTCHours(),
      utcDay:  date.getUTCDay(),   // 0=Sun … 6=Sat
      month:   date.getUTCMonth(), // 0-based
      year:    date.getUTCFullYear(),
    };
  }
  return null;
}

// ── Reporting helpers ──────────────────────────────────────────────────────────
const div  = () => console.log('  ' + '─'.repeat(56));
const hr   = () => console.log('='.repeat(66));
const pct  = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : 'n/a';
const sign = v => (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2);

function reportGroup(label, signals) {
  if (!signals.length) { console.log(`\n${label}\n  No signals.`); return; }
  const wins = signals.filter(s => s.won).length;
  const n    = signals.length;
  console.log(`\n${label}`);
  div();
  console.log(`  Signals: ${n}  |  ${wins}W / ${n - wins}L  |  Win rate: ${pct(wins, n)}`);
  console.log(`  Avg |window|: ${(signals.reduce((a,s) => a + Math.abs(s.pctWindow), 0) / n).toFixed(3)}%  |  Avg |spike60|: ${(signals.reduce((a,s) => a + Math.abs(s.spike60), 0) / n).toFixed(3)}%  |  Avg |resolution|: ${(signals.reduce((a,s) => a + Math.abs(s.resolutionMove), 0) / n).toFixed(3)}%`);

  for (const asset of ASSETS) {
    const sub = signals.filter(s => s.asset === asset);
    if (!sub.length) continue;
    const w = sub.filter(s => s.won).length;
    const est = sub.reduce((a, s) => a + tradePnl(s.won, 0.33), 0);
    console.log(`    ${asset.toUpperCase().padEnd(5)}  ${String(sub.length).padStart(4)} signals  ${w}W/${sub.length-w}L  ${pct(w,sub.length).padStart(6)} WR  | P&L @0.33: ${sign(est)}`);
  }

  console.log(`\n  P&L by CLOB entry price (bet=$${BET_SIZE}, fee=${(FEE_RATE*100).toFixed(0)}%):`);
  console.log(`  ${'CLOB'.padEnd(7)} ${'100% fill'.padEnd(13)} ${'80% fill'.padEnd(13)} ${'60% fill'.padEnd(13)} ${'40% fill'.padEnd(10)} EV/trade  BE-WR`);
  console.log(`  ${'─'.repeat(70)}`);
  for (const clob of CLOB_SCENARIOS) {
    const full = signals.reduce((a, s) => a + tradePnl(s.won, clob), 0);
    const ev   = full / n;
    const beWr = (clob / (1 - FEE_RATE) * 100).toFixed(1);
    const flag = parseFloat(pct(wins,n)) > parseFloat(beWr) ? '✓' : '✗';
    const cols = FILL_RATES.map(fr => (sign(full * fr)).padEnd(13));
    console.log(`  ${String(clob).padEnd(7)} ${cols.join('')} ${sign(ev).padEnd(9)} ${beWr}% ${flag}`);
  }
}

function reportSpikeBuckets(signals) {
  if (!signals.length) return;
  const buckets = [
    { label: '0.20-0.25%', min: 0.20, max: 0.25 },
    { label: '0.25-0.30%', min: 0.25, max: 0.30 },
    { label: '0.30-0.35%', min: 0.30, max: 0.35 },
    { label: '0.35-0.40%', min: 0.35, max: 0.40 },
    { label: '>0.40%',     min: 0.40, max: Infinity },
  ];
  console.log('\nPATH A (SPIKE) — WR by |spike60| magnitude:');
  console.log(`  ${'Spike60'.padEnd(12)} ${'N'.padEnd(6)} ${'WR%'.padEnd(8)} ${'EV@0.33'.padEnd(10)} ${'EV@0.31'.padEnd(10)} Note`);
  console.log(`  ${'─'.repeat(58)}`);
  for (const { label, min, max } of buckets) {
    const sub = signals.filter(s => Math.abs(s.spike60) >= min && Math.abs(s.spike60) < max);
    if (!sub.length) continue;
    const w  = sub.filter(s => s.won).length;
    const wr = (w / sub.length * 100).toFixed(1);
    const ev33 = (sub.reduce((a, s) => a + tradePnl(s.won, 0.33), 0) / sub.length);
    const ev31 = (sub.reduce((a, s) => a + tradePnl(s.won, 0.31), 0) / sub.length);
    const be   = (0.33 / (1 - FEE_RATE) * 100).toFixed(1);
    const flag = parseFloat(wr) > parseFloat(be) ? '✓ EDGE' : '✗ RISKY';
    console.log(`  ${label.padEnd(12)} ${String(sub.length).padEnd(6)} ${(wr+'%').padEnd(8)} ${sign(ev33).padEnd(10)} ${sign(ev31).padEnd(10)} ${flag}`);
  }
  console.log(`  (breakeven WR @0.33 = ${(0.33/(1-FEE_RATE)*100).toFixed(1)}%, @0.31 = ${(0.31/(1-FEE_RATE)*100).toFixed(1)}%)`);
}

function reportWindowBuckets(signals) {
  if (!signals.length) return;
  const buckets = [
    { label: '0.70-0.90%', min: 0.70, max: 0.90 },
    { label: '0.90-1.10%', min: 0.90, max: 1.10 },
    { label: '1.10-1.40%', min: 1.10, max: 1.40 },
    { label: '>1.40%',     min: 1.40, max: Infinity },
  ];
  console.log('\nPATH B (WINDOW) — WR by |pctWindow| magnitude:');
  console.log(`  ${'Window'.padEnd(12)} ${'N'.padEnd(6)} ${'WR%'.padEnd(8)} ${'EV@0.33'.padEnd(10)} Note`);
  console.log(`  ${'─'.repeat(44)}`);
  for (const { label, min, max } of buckets) {
    const sub = signals.filter(s => Math.abs(s.pctWindow) >= min && Math.abs(s.pctWindow) < max);
    if (!sub.length) continue;
    const w  = sub.filter(s => s.won).length;
    const wr = (w / sub.length * 100).toFixed(1);
    const ev = (sub.reduce((a, s) => a + tradePnl(s.won, 0.33), 0) / sub.length).toFixed(2);
    const flag = w === sub.length ? '100% WR' : `${sub.length-w} loss${sub.length-w>1?'es':''}`;
    console.log(`  ${label.padEnd(12)} ${String(sub.length).padEnd(6)} ${(wr+'%').padEnd(8)} ${(sign(parseFloat(ev))).padEnd(10)} ${flag}`);
  }
}

function reportDayOfWeek(signals) {
  if (!signals.length) return;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  console.log('\nWin rate by day of week (UTC):');
  console.log(`  ${'Day'.padEnd(5)} ${'N'.padEnd(6)} ${'WR%'.padEnd(8)} ${'EV@0.33'.padEnd(10)} Signals/wk`);
  console.log(`  ${'─'.repeat(40)}`);
  const weeks = DAYS_BACK / 7;
  for (let d = 0; d < 7; d++) {
    const sub = signals.filter(s => s.utcDay === d);
    if (!sub.length) continue;
    const w  = sub.filter(s => s.won).length;
    const wr = (w / sub.length * 100).toFixed(1);
    const ev = (sub.reduce((a, s) => a + tradePnl(s.won, 0.33), 0) / sub.length).toFixed(2);
    const perWk = (sub.length / weeks).toFixed(1);
    console.log(`  ${days[d].padEnd(5)} ${String(sub.length).padEnd(6)} ${(wr+'%').padEnd(8)} ${sign(parseFloat(ev)).padEnd(10)} ${perWk}`);
  }
}

function reportSession(signals) {
  if (!signals.length) return;
  // Asia: 22-08 UTC, Europe: 07-16 UTC, US: 13-22 UTC (overlaps intentional)
  const sessions = [
    { label: 'Asia   (22-08 UTC)', fn: h => h >= 22 || h < 8  },
    { label: 'Europe (07-16 UTC)', fn: h => h >= 7  && h < 16 },
    { label: 'US     (13-22 UTC)', fn: h => h >= 13 && h < 22 },
  ];
  console.log('\nWin rate by market session:');
  console.log(`  ${'Session'.padEnd(20)} ${'N'.padEnd(6)} ${'WR%'.padEnd(8)} ${'EV@0.33'.padEnd(10)} Signals/day`);
  console.log(`  ${'─'.repeat(52)}`);
  for (const { label, fn } of sessions) {
    const sub = signals.filter(s => fn(s.utcHour));
    if (!sub.length) continue;
    const w  = sub.filter(s => s.won).length;
    const wr = (w / sub.length * 100).toFixed(1);
    const ev = (sub.reduce((a, s) => a + tradePnl(s.won, 0.33), 0) / sub.length).toFixed(2);
    const perDay = (sub.length / DAYS_BACK).toFixed(1);
    console.log(`  ${label.padEnd(20)} ${String(sub.length).padEnd(6)} ${(wr+'%').padEnd(8)} ${sign(parseFloat(ev)).padEnd(10)} ${perDay}`);
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
  const maxN = Math.max(...Object.values(byHour).map(d => d.n));
  console.log('\nPATH B (WINDOW) — signals by UTC hour:');
  for (let h = 0; h < 24; h++) {
    const d = byHour[h];
    if (!d) continue;
    const wr  = (d.wins / d.n * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(d.n / maxN * 20));
    const blank = '░'.repeat(20 - bar.length);
    console.log(`  ${String(h).padStart(2,'0')}h  ${String(d.wins).padStart(3)}W/${String(d.n-d.wins).padStart(2)}L  ${String(wr).padStart(3)}%  ${bar}${blank}  ${d.n}`);
  }
}

function reportMonthly(signals) {
  if (!signals.length) return;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const byMonth = {};
  for (const s of signals) {
    const key = `${s.year}-${String(s.month).padStart(2,'0')}`;
    if (!byMonth[key]) byMonth[key] = { wins: 0, n: 0, label: `${months[s.month]} ${s.year}` };
    byMonth[key].n++;
    if (s.won) byMonth[key].wins++;
  }
  console.log('\nPATH B (WINDOW) — monthly breakdown:');
  console.log(`  ${'Month'.padEnd(10)} ${'N'.padEnd(6)} ${'WR%'.padEnd(8)} ${'P&L @0.33'.padEnd(12)} Signals/day`);
  console.log(`  ${'─'.repeat(46)}`);
  const daysPerMonth = DAYS_BACK / Object.keys(byMonth).length;
  for (const key of Object.keys(byMonth).sort()) {
    const d   = byMonth[key];
    const wr  = (d.wins / d.n * 100).toFixed(1);
    const est = d.wins * tradePnl(true, 0.33) + (d.n - d.wins) * tradePnl(false, 0.33);
    const perDay = (d.n / daysPerMonth).toFixed(1);
    console.log(`  ${d.label.padEnd(10)} ${String(d.n).padEnd(6)} ${(wr+'%').padEnd(8)} ${sign(est).padEnd(12)} ${perDay}`);
  }
}

function reportStreaks(allSignalsSorted) {
  if (!allSignalsSorted.length) return;
  let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
  for (const s of allSignalsSorted) {
    if (s.won) { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else        { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
  }
  console.log(`\nStreak analysis (PATH B, all signals in chronological order):`);
  console.log(`  Max consecutive wins  : ${maxWin}`);
  console.log(`  Max consecutive losses: ${maxLoss}`);
}

function reportBalanceSimulation(allSignalsSorted) {
  if (!allSignalsSorted.length) return;

  // Realistic simulation: cap at 3 trades/day (live daily limit), $20 fixed bet, CLOB=0.33
  // This avoids the exponential overflow from unlimited compounding.
  const MAX_PER_DAY = 3;
  const CLOB        = 0.33;

  for (const fillRate of [1.0, 0.60]) {
    let balance = 100;
    let peak    = 100;
    let maxDD   = 0;
    let dayKey  = '';
    let dayCount = 0;
    const equityByDay = { 0: 100 }; // day index → end balance
    let dayIdx = 0;
    let prevDayKey = '';

    for (const s of allSignalsSorted) {
      const dk = new Date(s.ts).toISOString().slice(0, 10);
      if (dk !== dayKey) { dayKey = dk; dayCount = 0; dayIdx++; }
      if (dayCount >= MAX_PER_DAY) continue;
      if (Math.random() > fillRate) continue;
      dayCount++;

      const size   = Math.min(balance * 0.25, BET_SIZE); // 25% or $20 max
      const shares = size / CLOB;
      const ret    = s.won ? shares * (1 - FEE_RATE) - size : -size;
      balance     += ret;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak;
      if (dd > maxDD) maxDD = dd;
      equityByDay[dayIdx] = balance;
    }

    // Sharpe over daily returns
    const dayKeys  = Object.keys(equityByDay).map(Number).sort((a,b)=>a-b);
    const dayRets  = [];
    for (let i = 1; i < dayKeys.length; i++) {
      const prev = equityByDay[dayKeys[i-1]];
      const cur  = equityByDay[dayKeys[i]] ?? prev;
      dayRets.push((cur - prev) / prev);
    }
    const meanR = dayRets.length ? dayRets.reduce((a,b)=>a+b,0)/dayRets.length : 0;
    const stdR  = dayRets.length > 1 ? Math.sqrt(dayRets.map(r=>(r-meanR)**2).reduce((a,b)=>a+b,0)/dayRets.length) : 0;
    const sharpe = stdR > 0 ? (meanR / stdR * Math.sqrt(252)).toFixed(2) : 'n/a';
    const totalRet = ((balance - 100) / 100 * 100).toFixed(1);

    console.log(`\n  Fill rate ${(fillRate*100).toFixed(0)}%: $100 → $${balance.toFixed(2)} (+${totalRet}%)  MaxDD=${(maxDD*100).toFixed(1)}%  Sharpe≈${sharpe}  (capped ${MAX_PER_DAY} trades/day, $20 bet)`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const nowMs   = Date.now();
  const startMs = nowMs - DAYS_BACK * 24 * 60 * 60 * 1000;

  console.log('\n' + '='.repeat(66));
  console.log('Oracle Lag Arb — Comprehensive Backtest');
  console.log('='.repeat(66));
  console.log(`Period  : ${new Date(startMs).toISOString().slice(0,10)} → ${new Date(nowMs).toISOString().slice(0,10)}`);
  console.log(`Assets  : ${ASSETS.map(a => a.toUpperCase()).join(', ')}`);
  console.log(`Days    : ${DAYS_BACK}`);
  console.log(`PATH B  : |pctWindow| ≥ ${WINDOW_MIN_PCT}% + |spike60| ≥ ${SPIKE60_MIN_PCT}% + anti-bounce ≤ ${ANTI_BOUNCE_THRESH}%`);
  console.log(`PATH A  : |spike60| ≥ ${SPIKE_MIN_PCT}% + |pctWindow| ≥ ${SPIKE_WINDOW_MIN}%  [DISABLED LIVE]`);
  console.log('Method  : Binance 1m klines, signal at 2-4 min mark, resolution at 5 min close');

  console.log('\n[1/2] Fetching Binance 1m klines...');
  const klineMaps = {};
  for (const asset of ASSETS) {
    klineMaps[asset] = await fetchAllKlines(BINANCE_SYMBOLS[asset], startMs - 15 * 60 * 1000, nowMs);
    await sleep(300);
  }

  console.log('\n[2/2] Simulating every 5-min window...');
  const windowSignals  = [];
  const spikeSignals   = [];
  const blockedSignals = [];
  let totalWindows = 0;

  for (const asset of ASSETS) {
    const klineMap = klineMaps[asset];
    const firstWindow = Math.ceil(startMs / 300000) * 300000;
    let wc = 0;
    for (let winMs = firstWindow; winMs < nowMs - 300000; winMs += 300000) {
      totalWindows++;
      wc++;
      const result = simulateWindow(winMs, klineMap);
      if (!result) continue;
      result.asset = asset;
      if (result.blockedByFilter) blockedSignals.push(result);
      else if (result.isWindow)   windowSignals.push(result);
      else if (result.isSpike)    spikeSignals.push(result);
    }
    console.log(`  ${asset.toUpperCase()}: ${wc} windows → ${windowSignals.filter(s=>s.asset===asset).length} WINDOW, ${spikeSignals.filter(s=>s.asset===asset).length} SPIKE, ${blockedSignals.filter(s=>s.asset===asset).length} BLOCKED`);
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('SIGNAL SUMMARY');
  console.log('='.repeat(66));
  console.log(`Total 5-min windows : ${totalWindows}`);
  console.log(`PATH B (WINDOW)     : ${windowSignals.length} signals  (${(windowSignals.length/totalWindows*100).toFixed(2)}% of windows, ${(windowSignals.length/DAYS_BACK).toFixed(1)}/day)`);
  console.log(`PATH A (SPIKE)      : ${spikeSignals.length} signals  (${(spikeSignals.length/totalWindows*100).toFixed(2)}% of windows, ${(spikeSignals.length/DAYS_BACK).toFixed(1)}/day)  [DISABLED]`);
  console.log(`Anti-bounce blocked : ${blockedSignals.length}`);
  console.log(`Combined A+B (live) : ${windowSignals.length} → if SPIKE re-enabled: ${windowSignals.length + spikeSignals.length} (+${((spikeSignals.length/Math.max(1,windowSignals.length))*100).toFixed(0)}% volume)`);

  reportGroup('\nPATH B (WINDOW) — LIVE', windowSignals);
  reportGroup('\nPATH A (SPIKE) — DISABLED', spikeSignals);

  // ── SPIKE magnitude segmentation ───────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('SPIKE RE-ENABLE DECISION MATRIX');
  console.log('='.repeat(66));
  reportSpikeBuckets(spikeSignals);
  // Recommendation
  const strong = spikeSignals.filter(s => Math.abs(s.spike60) >= 0.28);
  const weak   = spikeSignals.filter(s => Math.abs(s.spike60) <  0.28);
  if (strong.length && weak.length) {
    const sWR = (strong.filter(s=>s.won).length/strong.length*100).toFixed(1);
    const wWR = (weak.filter(s=>s.won).length/weak.length*100).toFixed(1);
    const dropped = weak.length;
    const retained = strong.length;
    console.log(`\n  → If SPIKE floor raised to 0.28%: keep ${retained} signals (${sWR}% WR), drop ${dropped} weak (${wWR}% WR)`);
    console.log(`    Recommended SPIKE floor: 0.28%  (re-enable after latency p99 confirmed <600ms)`);
  }

  // ── Anti-bounce ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('ANTI-BOUNCE FILTER ANALYSIS');
  console.log('='.repeat(66));
  const totalCandidates = windowSignals.length + spikeSignals.length + blockedSignals.length;
  if (blockedSignals.length > 0) {
    const wouldWin  = blockedSignals.filter(s => s.direction === s.resolution).length;
    const wouldLose = blockedSignals.length - wouldWin;
    const saved     = wouldLose * BET_SIZE;
    const cost      = wouldWin * tradePnl(true, 0.33);
    const netImpact = saved - cost;
    console.log(`  Candidates (before filter) : ${totalCandidates}`);
    console.log(`  Blocked                    : ${blockedSignals.length} (${pct(blockedSignals.length, totalCandidates)})`);
    console.log(`  Blocked WR                 : ${pct(wouldWin, blockedSignals.length)} would have won`);
    console.log(`  Net P&L impact @CLOB=0.33  : ${sign(netImpact)} (saved ${wouldLose} losses, blocked ${wouldWin} wins)`);
    console.log(`  Verdict: filter is ${netImpact >= 0 ? 'NET POSITIVE' : 'NET NEGATIVE'} over ${DAYS_BACK} days`);
  }

  // ── Granular breakdowns ─────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('GRANULAR BREAKDOWNS — PATH B');
  console.log('='.repeat(66));
  reportWindowBuckets(windowSignals);
  reportDayOfWeek(windowSignals);
  reportSession(windowSignals);
  reportHourly(windowSignals);
  reportMonthly(windowSignals);

  // ── Streak + balance simulation ─────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('RISK ANALYSIS');
  console.log('='.repeat(66));
  const allSorted = [...windowSignals].sort((a,b) => a.ts - b.ts);
  reportStreaks(allSorted);
  console.log('\nBalance simulation (start $100, 25% per trade, CLOB=0.33):');
  reportBalanceSimulation(allSorted);

  // ── Projected rates ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('PROJECTIONS');
  console.log('='.repeat(66));
  const winB  = windowSignals.filter(s=>s.won).length;
  const wrB   = (winB/Math.max(1,windowSignals.length)*100).toFixed(1);
  const pnl33 = windowSignals.reduce((a,s) => a + tradePnl(s.won, 0.33), 0);

  console.log(`\nPATH B only (current live config):`);
  console.log(`  ${(windowSignals.length/DAYS_BACK).toFixed(1)} signals/day | ${wrB}% WR | +${sign(pnl33/DAYS_BACK)}/day | +${sign(pnl33/DAYS_BACK*7)}/week (theoretical 100% fill)`);

  for (const fr of [0.80, 0.60]) {
    console.log(`  At ${(fr*100).toFixed(0)}% fill rate: +${sign(pnl33/DAYS_BACK*fr)}/day | +${sign(pnl33/DAYS_BACK*7*fr)}/week`);
  }

  if (spikeSignals.length > 0) {
    const winA   = spikeSignals.filter(s=>s.won).length;
    const wrA    = (winA/spikeSignals.length*100).toFixed(1);
    const pnlA33 = spikeSignals.reduce((a,s) => a + tradePnl(s.won, 0.33), 0);
    const combPnl = pnl33 + pnlA33;
    console.log(`\nPATH A+B (if SPIKE re-enabled at 0.20% floor):`);
    console.log(`  ${((windowSignals.length+spikeSignals.length)/DAYS_BACK).toFixed(1)} signals/day | combined +${sign(combPnl/DAYS_BACK)}/day (theoretical)`);
    console.log(`  At 60% fill rate: +${sign(combPnl/DAYS_BACK*0.60)}/day`);

    const strongSpike = spikeSignals.filter(s => Math.abs(s.spike60) >= 0.28);
    if (strongSpike.length) {
      const pnlStrong = strongSpike.reduce((a,s) => a + tradePnl(s.won, 0.33), 0);
      const combStrong = pnl33 + pnlStrong;
      console.log(`\nPATH A+B (SPIKE floor raised to 0.28%):`);
      console.log(`  ${((windowSignals.length+strongSpike.length)/DAYS_BACK).toFixed(1)} signals/day | combined +${sign(combStrong/DAYS_BACK)}/day (theoretical)`);
      console.log(`  At 60% fill rate: +${sign(combStrong/DAYS_BACK*0.60)}/day`);
    }
  }

  console.log('\n' + '='.repeat(66));
  console.log('LIMITATIONS');
  console.log('='.repeat(66));
  console.log('  ⚠  Resolution = Binance 5-min close direction (not Chainlink). Accurate');
  console.log('     on strong moves (>0.1%), ~95%+ agreement. Flat windows excluded.');
  console.log('  ⚠  CLOB prices assumed — actual fill depends on book depth and staleness.');
  console.log('  ⚠  Fill rate unknown — backtest shows 100% filled. Live rate TBD from');
  console.log('     latency data (p99 < 400ms → ~80% fill, >600ms → ~40% fill estimated).');
  console.log('  ⚠  PATH C (REVERSAL) not modelled — requires historical CLOB order book.');
  console.log('  ⚠  Balance simulation uses fixed 25% fraction, not the tiered live sizing.');
  console.log('  ⚠  Apr 8 broad sell-off type days: CLOB reprices immediately. Filter');
  console.log('     detects these via velocity check but backtest cannot simulate them.');
  console.log('');
}

main().catch(err => { console.error('\nBacktest error:', err.message); process.exit(1); });
