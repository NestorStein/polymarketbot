/**
 * auto_monitor.js — self-restarting price monitor
 * Writes to monitor.log every 20s and alert.log when >= 0.5% window moves are detected.
 * Run once with: nohup node auto_monitor.js >> /dev/null 2>&1 &
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const LOG_FILE   = path.join(__dirname, 'monitor.log');
const ALERT_FILE = path.join(__dirname, 'alert.log');
const SYMBOLS    = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT'];
const INTERVAL   = 20_000; // 20 seconds
const THRESHOLD  = 0.5;    // % window move to alert

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function appendLog(file, line) {
  try { fs.appendFileSync(file, line + '\n'); } catch {}
}

async function tick() {
  const now      = Math.floor(Date.now() / 1000);
  const winStart = Math.floor(now / 300) * 300 * 1000;
  const utcHour  = new Date().getUTCHours();
  const gate     = (utcHour >= 12 && utcHour < 22) ? 'OPEN' : 'CLOSED';
  const ts       = new Date().toISOString().replace('T',' ').slice(0,19);

  const fetches = SYMBOLS.map(sym =>
    getJson(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=6`)
      .then(candles => {
        const winCandles = candles.filter(c => c[0] >= winStart);
        if (!winCandles.length) return { sym: sym.replace('USDT',''), pct: 0 };
        const open  = parseFloat(winCandles[0][1]);
        const close = parseFloat(candles[candles.length - 1][4]);
        const pct   = ((close - open) / open) * 100;
        return { sym: sym.replace('USDT',''), pct };
      })
      .catch(() => ({ sym: sym.replace('USDT',''), pct: 0 }))
  );

  let results;
  try { results = await Promise.all(fetches); } catch { return; }

  results.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const flag = r => Math.abs(r.pct) >= THRESHOLD ? ' ***' : '';
  const fmt  = r => `${r.sym}${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}%${flag(r)}`;
  const line = `[${ts}] Gate:${gate} | ${results.map(fmt).join(' | ')}`;

  appendLog(LOG_FILE, line);

  // Write alert.log for any asset crossing threshold while gate is open
  if (gate === 'OPEN') {
    results.filter(r => Math.abs(r.pct) >= THRESHOLD).forEach(r => {
      const dir   = r.pct > 0 ? 'UP' : 'DOWN';
      const alert = `[ALERT ${ts}] ${r.sym} ${dir} ${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(3)}% — bot should fire`;
      appendLog(ALERT_FILE, alert);
      process.stdout.write(alert + '\n');
    });
  }
}

// Run tick on interval, with error swallowing so it never crashes
async function loop() {
  process.stdout.write(`[auto_monitor] started PID=${process.pid}\n`);
  while (true) {
    const start = Date.now();
    try { await tick(); } catch {}
    const elapsed = Date.now() - start;
    const wait    = Math.max(0, INTERVAL - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }
}

loop();
