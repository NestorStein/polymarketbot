'use strict';
/**
 * Autonomous bot monitor — runs alongside the main bot via PM2.
 * Checks every 60s:
 *   - Bot process online? → restart if not
 *   - Bot stuck (no log output for 3+ min)? → restart
 *   - USDC balance < $10? → pause trading automatically
 *   - Balance recovered? → resume trading
 *   - Binance + CLOB WS connected? → restart if both dead
 *   - Writes rolling summary to monitor_summary.txt
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const LOG_FILE     = path.join(__dirname, 'monitor_log.txt');
const SUMMARY_FILE = path.join(__dirname, 'monitor_summary.txt');
const CHECK_MS     = 60_000;        // check every 60s
const STUCK_MS     = 3 * 60_000;   // restart if no log output for 3 min
const MIN_BALANCE  = 10;            // pause trading if USDC < $10
const DASHBOARD    = 'http://localhost:3002';

let checksRun    = 0;
let botRestarts  = 0;
let autoPauses   = 0;
let tradesTotal  = 0;
let lastTradeCnt = 0;
let lastLogLine  = '';
let lastLogTs    = Date.now();
let paused       = false;
let sessionStart = new Date();

// ── Helpers ────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function api(path) {
  return new Promise((resolve) => {
    http.get(DASHBOARD + path, { timeout: 5000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function pm2List() {
  try { return JSON.parse(execSync('pm2 jlist', { timeout: 10000 }).toString()); }
  catch { return null; }
}

function pm2Restart() {
  execSync('pm2 restart polymarket-bot --update-env', { timeout: 20000 });
  botRestarts++;
}

function readLastLog(n = 80) {
  try {
    const logPath = path.join(process.env.HOME || 'C:/Users/root', '.pm2/logs/polymarket-bot-out.log');
    const content = fs.readFileSync(logPath, 'utf8');
    const lines   = content.trim().split('\n');
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

function countTrades(logText) {
  return (logText.match(/GTC order placed/g) || []).length;
}

// ── Main check ─────────────────────────────────────────────────────────────

async function check() {
  checksRun++;

  // 1. PM2 status
  const list = pm2List();
  if (!list) {
    log('⚠ PM2 not responding');
    return;
  }
  const bot = list.find(p => p.name === 'polymarket-bot');
  if (!bot) {
    log('⚠ polymarket-bot not in PM2 — attempting start');
    try { execSync('pm2 start index.js --name polymarket-bot', { timeout: 20000, cwd: __dirname }); botRestarts++; log('✅ Started'); } catch(e) { log('❌ Start failed: ' + e.message); }
    return;
  }
  if (bot.pm2_env.status !== 'online') {
    log(`⚠ Bot status=${bot.pm2_env.status} — restarting`);
    try { pm2Restart(); log('✅ Restarted'); } catch(e) { log('❌ Restart failed: ' + e.message); }
    return;
  }

  // 2. Stuck check — use log FILE mtime, not last-line content.
  // The bot logs "[OracleLag] Tracking X markets" every 15s; the text is identical
  // on repeated calls so a last-line diff always looks "unchanged". mtime is authoritative.
  const logText = readLastLog(80);
  try {
    const logPath = path.join(process.env.HOME || 'C:/Users/root', '.pm2/logs/polymarket-bot-out.log');
    const mtime = fs.statSync(logPath).mtimeMs;
    if (mtime > lastLogTs) lastLogTs = mtime;
  } catch {}
  if (Date.now() - lastLogTs > STUCK_MS) {
    log(`⚠ Bot stuck (log file not written for ${Math.round((Date.now()-lastLogTs)/60000)}min) — restarting`);
    try { pm2Restart(); log('✅ Restarted (stuck)'); lastLogTs = Date.now(); } catch(e) { log('❌ ' + e.message); }
    return;
  }

  // 3. WS health — must see aggTrade stream activity in recent logs (Binance alive).
  // 'Tracking' lines appear even during restarts so they're not reliable; use aggTrade.
  const wsOk = logText.includes('aggTrade') || logText.includes('Binance WS connected') || logText.includes('CLOB WS subscribed');
  if (!wsOk) {
    log('⚠ No WS activity in recent logs — restarting');
    try { pm2Restart(); log('✅ Restarted (WS dead)'); } catch(e) { log('❌ ' + e.message); }
    return;
  }

  // 4. Trade count
  const tradeCnt = countTrades(logText);
  const newTrades = tradeCnt - lastTradeCnt;
  if (newTrades > 0) {
    tradesTotal += newTrades;
    log(`💰 ${newTrades} new trade(s) placed — session total: ${tradesTotal}`);
  }
  lastTradeCnt = tradeCnt;

  // 5. Balance check via dashboard API
  const balData = await api('/api/balance');
  const balance = balData?.balance ?? null;

  if (balance !== null) {
    if (balance < MIN_BALANCE && !paused) {
      log(`🛑 Balance $${balance.toFixed(2)} < $${MIN_BALANCE} — pausing trading`);
      try {
        const r = await fetch(DASHBOARD + '/api/bot/pause', { method: 'POST' });
        paused = true; autoPauses++;
        log('✅ Trading paused (low balance)');
      } catch(e) { log('⚠ Pause API failed: ' + e.message); }
    } else if (balance >= MIN_BALANCE + 5 && paused) {
      log(`✅ Balance $${balance.toFixed(2)} recovered — resuming trading`);
      try {
        await fetch(DASHBOARD + '/api/bot/resume', { method: 'POST' });
        paused = false;
        log('✅ Trading resumed');
      } catch(e) { log('⚠ Resume API failed: ' + e.message); }
    }
  }

  // 6. Rolling summary
  const upMins = Math.round((Date.now() - sessionStart.getTime()) / 60000);
  const summary = [
    '=== BOT MONITOR SUMMARY ===',
    `Time          : ${new Date().toLocaleString()}`,
    `Session start : ${sessionStart.toLocaleString()}`,
    `Uptime        : ${Math.floor(upMins/60)}h ${upMins%60}m`,
    `Checks run    : ${checksRun}`,
    `Bot PM2 status: ${bot.pm2_env.status}`,
    `PM2 restarts  : ${bot.pm2_env.restart_time}`,
    `Monitor restarts: ${botRestarts}`,
    `Trades fired  : ${tradesTotal}`,
    `Auto-pauses   : ${autoPauses}`,
    `Balance       : ${balance !== null ? '$'+balance.toFixed(2) : 'unknown'}`,
    `Trading       : ${paused ? 'PAUSED (low balance)' : 'ACTIVE'}`,
    `Memory        : ${Math.round((bot.monit?.memory||0)/1024/1024)}MB`,
    '===========================',
  ].join('\n');
  try { fs.writeFileSync(SUMMARY_FILE, summary + '\n'); } catch {}

  // Periodic heartbeat log (every 10 checks = ~10 min)
  if (checksRun % 10 === 0) {
    log(`💓 Heartbeat — uptime ${Math.floor(upMins/60)}h${upMins%60}m | balance $${balance?.toFixed(2)||'?'} | trades ${tradesTotal} | restarts ${botRestarts}`);
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

log(`=== Monitor started | session: ${sessionStart.toLocaleString()} | balance floor: $${MIN_BALANCE} ===`);
check();
setInterval(check, CHECK_MS);
