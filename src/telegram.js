'use strict';

const https = require('https');

/**
 * Send a Telegram message. Fire-and-forget — never throws.
 * Reads TOKEN/CHAT_ID at call time (not module load) so dotenv has run first.
 * Uses Node's built-in https so there's no extra dependency.
 */
function send(text) {
  const TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';
  if (!TOKEN || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  req.on('error', () => {}); // never crash the bot on alert failure
  req.write(body);
  req.end();
}

// ── Alert helpers ─────────────────────────────────────────────────────────────

function tradeAlert({ symbol, direction, path, clobPrice, size, orderId, timeframe }) {
  send(
    `🎯 <b>TRADE</b> [${path}][${timeframe}]\n` +
    `${symbol} <b>${direction}</b> @ ${clobPrice.toFixed(3)}\n` +
    `Size: $${size.toFixed(2)} | Order: <code>${String(orderId).slice(0, 20)}…</code>`
  );
}

function signalAlert({ symbol, direction, path, clobPrice, maxClobPrice, pctWindow, spike60, blocked_by, timeframe }) {
  const statusIcon = blocked_by ? '⛔' : '🔥';
  const reason     = blocked_by ? ` blocked: ${blocked_by}` : ' → TRADING';
  send(
    `${statusIcon} <b>SIGNAL</b> [${path}][${timeframe}]${reason}\n` +
    `${symbol} ${direction} | window=${pctWindow >= 0 ? '+' : ''}${pctWindow.toFixed(3)}% 60s=${spike60 >= 0 ? '+' : ''}${spike60.toFixed(3)}%\n` +
    `CLOB=${clobPrice.toFixed(3)} max=${maxClobPrice.toFixed(3)}`
  );
}

function circuitBreakerAlert({ dailyLoss, maxDailyLoss, balance }) {
  send(
    `⛔ <b>CIRCUIT BREAKER</b>\n` +
    `Daily loss $${dailyLoss.toFixed(2)} hit limit $${maxDailyLoss}\n` +
    `Balance: $${balance.toFixed(2)} — trading paused for today`
  );
}

function clobWsReconnectAlert() {
  send(`⚡ <b>CLOB WS reconnected</b> — 30s of snapshot-only prices, HTTP fallback active`);
}

function dailySummary({ date, tradeCount, maxTrades, balance, startBalance, signalCount }) {
  const pnl     = balance - startBalance;
  const pnlSign = pnl >= 0 ? '+' : '';
  send(
    `📊 <b>Daily Summary</b> — ${date}\n` +
    `Trades: ${tradeCount}/${maxTrades} | Signals logged: ${signalCount}\n` +
    `Balance: $${balance.toFixed(2)} (${pnlSign}$${pnl.toFixed(2)})\n` +
    `Signal→trade ratio: ${tradeCount}/${signalCount} (${signalCount > 0 ? ((tradeCount / signalCount) * 100).toFixed(1) : 0}%)`
  );
}

function startupAlert({ balance, markets5m, markets15m, markets4h }) {
  send(
    `🚀 <b>Bot started</b>\n` +
    `Balance: $${balance.toFixed(2)}\n` +
    `Markets: ${markets5m} × 5m | ${markets15m} × 15m | ${markets4h} × 4h`
  );
}

// ── Command polling ───────────────────────────────────────────────────────────

/**
 * Long-poll Telegram for incoming messages. Calls `handler(command, chatId)`
 * for every text message that starts with '/'. Fire-and-forget loop, never throws.
 * Only starts if TOKEN + CHAT_ID are configured.
 */
function startPolling(handler) {
  const TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';
  if (!TOKEN || !CHAT_ID) return;

  let offset = 0;

  function getJson(path) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'api.telegram.org', path, method: 'GET' },
        res => {
          let raw = '';
          res.on('data', d => raw += d);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
        }
      );
      req.on('error', reject);
      req.setTimeout(35000, () => req.destroy());
      req.end();
    });
  }

  async function poll() {
    while (true) {
      try {
        const data = await getJson(`/bot${TOKEN}/getUpdates?offset=${offset}&timeout=30`);
        if (!data?.ok || !Array.isArray(data.result)) {
          console.warn('[Telegram] getUpdates failed:', JSON.stringify(data)?.slice(0, 120));
          await new Promise(r => setTimeout(r, 5000)); continue;
        }

        for (const update of data.result) {
          offset = update.update_id + 1;
          const text   = update.message?.text?.trim();
          const fromId = String(update.message?.chat?.id || '');
          // Only respond to the configured chat
          if (!text || fromId !== CHAT_ID) continue;
          if (text.startsWith('/')) {
            const cmd = text.split(' ')[0].toLowerCase();
            console.log(`[Telegram] Command received: ${cmd} from ${fromId}`);
            try { await handler(cmd, fromId); } catch (e) { console.warn('[Telegram] Handler error:', e.message); }
          }
        }
      } catch { await new Promise(r => setTimeout(r, 5000)); }
    }
  }

  poll(); // run forever in background
}

module.exports = { send, tradeAlert, signalAlert, circuitBreakerAlert, clobWsReconnectAlert, dailySummary, startupAlert, startPolling };
