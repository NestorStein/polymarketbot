'use strict';

/**
 * Oracle Latency Arbitrage — THE #1 documented Polymarket edge
 *
 * Targets "Bitcoin/Ethereum/Solana/XRP/DOGE/BNB Up or Down" markets across timeframes:
 *   5-minute:  slug {asset}-updown-5m-{ts}  (ts = multiple of 300)
 *   15-minute: slug {asset}-updown-15m-{ts} (ts = multiple of 900)
 *   4-hour:    slug {asset}-updown-4h-{ts}  (ts = multiple of 14400)
 *
 * Strategy:
 *  - Binance spot price moves BEFORE Polymarket order book reprices (~55s lag)
 *  - Detect SUDDEN moves via aggTrade stream (sub-second) + rolling price history
 *  - CLOB prices tracked via Polymarket WebSocket (zero HTTP latency)
 *  - For 15m/4h markets: only enter in final 8 minutes (same oracle lag applies, far more liquidity)
 *  - Signal paths:
 *    PATH A (spike-led):  spike60 ≥ 0.20% + window ≥ 0.20% → CLOB < 0.38  [RE-ENABLED: p99=497ms, 98.6% WR]
 *    PATH B (window-led): window ≥ 0.55% + spike60 ≥ 0.12% + no prior bounce → CLOB < 0.44
 *    PATH C (reversal):   CLOB stale >0.70 vs spot direction → buy cheap side, CLOB < 0.30-0.42
 *    PATH D (early):      spike15 ≥ 0.10% OR spike10 ≥ 0.08% → CLOB < 0.40, WS age < 1.5s
 *
 * Fee note: these markets use crypto_fees_v2 with 7.2% taker rate.
 */

const WebSocket = require('ws');
const axios = require('axios');
const EventEmitter = require('events');
const { checkSentiment, shouldTrade } = require('../newsSentiment');
const tg = require('../telegram');

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Slug asset prefix → Binance symbol
// Active assets only — based on deep analysis of 31 settled trades (Mar 26 – Apr 8 2026):
//   ETH:  4W/4L  50%  +$3.80  ← reliable
//   DOGE: 2W/0L 100% +$10.62  ← best performer (wider oracle lag window)
//   BTC:  2W/3L  40%  +$0.37  ← near-neutral, keep
//   SOL:  4W/7L  36% -$30.24  ← DISABLED: highest volatility, MMs reprice fastest
//   XRP:  1W/3L  25%  -$4.21  ← DISABLED: below breakeven, weak signals
//   BNB:  0W/1L   0%  -$5.27  ← DISABLED: insufficient data, single loss
const ASSET_SYMBOL_MAP = {
  btc:  'BTC',
  eth:  'ETH',
  doge: 'DOGE',
};

// Asset+timeframe combos with confirmed zero edge — never trade, skip to reduce eval load.
// Analysis of Apr 14 2026 (7,680 signals):
//   btc-5m:  1,075 signals, 100% CLOB_OVER (avg 0.989) — MMs price BTC 5m instantly
//   eth-5m:  1,951 signals, 100% CLOB_OVER (avg 0.989) — same
//   btc-4h:     36 signals, 100% CLOB_FLOOR (avg 0.089) — never clears the 0.28 floor
// btc-4h: CLOB floor issue (avg 0.089 — never clears 0.28 floor)
// eth-4h/doge-4h: 4h window too long for REVERSAL logic — 2 losses confirmed Apr 26
// btc-5m/eth-5m: MMs reprice instantly (100% CLOB_OVER)
const DISABLED_COMBOS = new Set(['btc-5m', 'eth-5m', 'btc-4h', 'eth-4h', 'doge-4h']);

class OracleLagArb extends EventEmitter {
  constructor(config, polyClient) {
    super();
    this.config = config;
    this.poly = polyClient;
    this.ws = null;            // Binance WebSocket
    this.clobWs = null;        // Polymarket CLOB WebSocket
    this.prices = {};          // symbol → { current, ts }
    this.markets = new Map();  // conditionId → market object
    this.clobPrices = {};      // tokenId → { bid, ask, ts } — updated in real-time
    this.subscribedTokens = new Set(); // tokens currently subscribed on CLOB WS
    this.running = false;
    this.paused  = false;
    this.maxTradesPerHour = 24;        // ↑ from 12
    this.maxConcurrentPositions = 6;   // ↑ from 4
    this.tradeTimestamps = [];
    this.tradedMarkets = new Set();
    this.evaluatingMarkets = new Set(); // conditionIds currently mid-evaluation (race guard)
    this.activePositions = 0;
    this.committedUsdc = 0;
    this.windowOpenPrices = new Map(); // symbol → price at start of current 5-min window
    this.windowOpenPrices15m = new Map(); // symbol → price at start of current 15-min window
    this.windowOpenTs15m = 0;            // last 15m boundary timestamp
    this.priceHistory = {};            // symbol → [{price, ts}] rolling 120s buffer
    this.lastEvalTs    = {};           // symbol → ts of last evaluation (move-triggered throttle)
    this.lastEvalPrice = {};           // symbol → price at last evaluation
    this.fokCooldown      = {};         // conditionId → ts of last FOK failure (30s retry block)
    this._nearMissCooldown = {};        // conditionId → ts of last near-miss alert (60s cooldown)
    this._watchedPositions = [];        // [{conditionId, direction, entryPrice, size, market, path, symbol, ts}] for settlement polling

    // ── Risk tracking ──────────────────────────────────────────────────────────
    this.sessionPeak      = 0;         // highest balance seen this session (for drawdown calc)
    this.dayString        = '';        // YYYY-MM-DD of current trading day
    this.dayStartBalance  = 0;         // balance at start of current calendar day
    this.dayTradeCount    = 0;         // trades placed today (resets at UTC midnight)
    this.dayTradeString   = '';        // date of last dayTradeCount reset

    // ── WS health watchdog ─────────────────────────────────────────────────────
    this.lastBinanceTick  = 0;         // ms timestamp of last Binance aggTrade message
    this._wsSuspended     = false;     // true when feed is 10–30s stale → block signal eval
    this._wsSuspendAlerted = false;    // prevent repeated Telegram alerts during suspend window
    this._freshTickCount  = 0;         // consecutive ticks since reconnect; signals resume at 3

    // ── Loss recovery & protection ─────────────────────────────────────────────
    this.dayWinCount      = 0;         // wins today (for consecutive loss tracking)
    this.dayLossCount     = 0;         // losses today
    this.consecutiveLosses = 0;        // streak of losses with no win in between

    // ── Cached balance (refreshed every 20s to avoid per-trade HTTP) ──────────
    this._cachedBalance   = null;      // USDC balance, null until first fetch
    this._balanceFetchTs  = 0;         // ms timestamp of last balance fetch
  }

  /** Refresh balance cache — called on start and every 20s */
  async _refreshBalance() {
    try {
      const bal = await this.poly.getBalance();
      this._cachedBalance  = bal;
      this._balanceFetchTs = Date.now();
      if (bal > this.sessionPeak) this.sessionPeak = bal;
    } catch { /* keep stale value */ }
  }

  /** Seed dayTradeCount + dayStartBalance from persisted state so restarts don't lose today's data */
  _seedDayCountFromLog() {
    const fs   = require('fs');
    const path = require('path');
    const today = new Date().toLocaleDateString();

    // Restore dayStartBalance from day_state.json if it's from today
    try {
      const stateFile = path.join(__dirname, '..', '..', 'day_state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.date === today && state.startBalance > 0) {
          this.dayStartBalance = state.startBalance;
          console.log(`[OracleLag] Restored dayStartBalance=$${state.startBalance.toFixed(2)} from day_state`);
        }
      }
    } catch { /* ignore */ }

    // Seed dayTradeCount from bet_log
    try {
      const file = path.join(__dirname, '..', '..', 'bet_log.json');
      if (!fs.existsSync(file)) return;
      const log   = JSON.parse(fs.readFileSync(file, 'utf8'));
      const count = log.filter(e => e.result !== 'CANCELLED' && new Date(e.ts).toLocaleDateString() === today).length;
      if (count > 0) {
        this.dayTradeCount = count;
        console.log(`[OracleLag] Seeded dayTradeCount=${count} from bet_log`);
      }
    } catch { /* ignore */ }
  }

  /** Persist today's start balance to disk so it survives restarts */
  _persistDayState() {
    try {
      const fs   = require('fs');
      const path = require('path');
      const state = { date: new Date().toLocaleDateString(), startBalance: this.dayStartBalance };
      fs.writeFileSync(path.join(__dirname, '..', '..', 'day_state.json'), JSON.stringify(state));
    } catch { /* ignore */ }
  }

  /** Start oracle lag monitor */
  async start() {
    this.running = true;
    await this._refreshCryptoMarkets();
    await this._refreshBalance();
    this._seedDayCountFromLog();
    this._connectBinance();
    this._connectClobWs();
    setInterval(() => this._refreshCryptoMarkets(), 15 * 1000); // ↑ from 30s
    setInterval(() => this._refreshBalance(), 20 * 1000);       // keep balance cache fresh
    this._scheduleWindowReset();
    this._startBinanceWatchdog();
    setInterval(() => this._pollSettledPositions(), 30 * 1000); // check settlements every 30s
    console.log('[OracleLag] Started — watching BTC/ETH/DOGE Up or Down markets (5m + 15m + 4h) | SOL/XRP/BNB disabled');
    const mkts = [...this.markets.values()];
    tg.startupAlert({ balance: this._cachedBalance || 0, markets5m: mkts.filter(m => m._timeframe==='5m').length, markets15m: mkts.filter(m => m._timeframe==='15m').length, markets4h: mkts.filter(m => m._timeframe==='4h').length });
  }

  /** Schedule window price resets at each 5-minute market boundary */
  _scheduleWindowReset() {
    const now = Date.now();
    const msUntilNext5min = (5 * 60 * 1000) - (now % (5 * 60 * 1000));
    const doReset = () => {
      if (!this.running) return;
      this.windowOpenPrices.clear();
      for (const [symbol, data] of Object.entries(this.prices)) {
        if (data?.current) this.windowOpenPrices.set(symbol, data.current);
      }
      // Reset 15m reference at 15-minute boundaries (every 3rd 5m reset)
      const now15 = Math.floor(Date.now() / 900000) * 900000;
      if (now15 !== this.windowOpenTs15m) {
        this.windowOpenTs15m = now15;
        this.windowOpenPrices15m.clear();
        for (const [symbol, data] of Object.entries(this.prices)) {
          if (data?.current) this.windowOpenPrices15m.set(symbol, data.current);
        }
        console.log('[OracleLag] Window reset — 5m + 15m reference prices updated');
      } else {
        console.log('[OracleLag] Window reset — 5m reference prices updated');
      }
      this._refreshCryptoMarkets().catch(() => {});
      let rapid = 0;
      const rapidId = setInterval(() => {
        if (!this.running || ++rapid >= 11) { clearInterval(rapidId); return; }
        this._refreshCryptoMarkets().catch(() => {});
      }, 6000);
    };
    setTimeout(() => {
      doReset();
      setInterval(doReset, 5 * 60 * 1000);
    }, msUntilNext5min);
    console.log(`[OracleLag] Next window reset in ${Math.round(msUntilNext5min / 1000)}s`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Polymarket CLOB WebSocket — real-time bid/ask for all tracked tokens
  // ─────────────────────────────────────────────────────────────────────────────

  _connectClobWs() {
    if (!this.running) return;
    this.clobWs = new WebSocket(CLOB_WS_URL);

    this.clobWs.on('open', () => {
      console.log('[OracleLag] Polymarket CLOB WS connected');
      // Resubscribe to all known tokens after reconnect
      const tokens = [...this.subscribedTokens];
      if (tokens.length > 0) this._sendClobSubscription(tokens);
    });

    this.clobWs.on('message', (raw) => {
      try {
        const msgs = JSON.parse(raw);
        const arr = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of arr) {
          // Initial orderbook snapshot — extract best bid/ask + depth from bids[]/asks[]
          if (msg.bids && msg.asks && msg.asset_id) {
            const bidPrices = msg.bids.map(b => parseFloat(b.price)).filter(p => !isNaN(p));
            const askEntries = msg.asks
              .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
              .filter(a => !isNaN(a.price) && !isNaN(a.size));
            const bestBid   = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
            const lowestAsk = askEntries.length > 0 ? Math.min(...askEntries.map(a => a.price)) : null;
            const prev = this.clobPrices[msg.asset_id];
            this.clobPrices[msg.asset_id] = {
              bid: bestBid, ask: lowestAsk,
              asks: askEntries,   // full depth for liquidity check
              prevAsk: prev?.ask ?? lowestAsk, prevAskTs: prev?.ts ?? Date.now(),
              ts: Date.now(),
            };
          }
          // Real-time price_changes — has best_bid and best_ask directly.
          // Tracking lastPriceChangeTs separately: this is the signal that the WS
          // connection is live and the book price reflects real current liquidity,
          // not a stale snapshot artifact. Used in _getClobPrice to bypass the
          // 0.95 filter for tokens that have seen recent confirmed price_change events.
          if (msg.price_changes) {
            for (const change of msg.price_changes) {
              if (!change.asset_id) continue;
              const bid = change.best_bid != null ? parseFloat(change.best_bid) : null;
              const ask = change.best_ask != null ? parseFloat(change.best_ask) : null;
              if (bid != null || ask != null) {
                const prev = this.clobPrices[change.asset_id];
                this.clobPrices[change.asset_id] = {
                  bid, ask,
                  asks: prev?.asks ?? [],
                  prevAsk: prev?.ask ?? ask, prevAskTs: prev?.ts ?? Date.now(),
                  ts: Date.now(),
                  lastPriceChangeTs: Date.now(), // confirmed live event
                };
              }
            }
          }
        }
      } catch { /* ignore parse errors */ }
    });

    this.clobWs.on('error', err => console.warn('[OracleLag] CLOB WS error:', err.message));
    this.clobWs.on('close', () => {
      if (this.running) {
        console.log('[OracleLag] CLOB WS closed — reconnecting in 3s');
        tg.clobWsReconnectAlert();
        setTimeout(() => this._connectClobWs(), 3000);
      }
    });
  }

  /** Subscribe new token IDs on the CLOB WebSocket */
  _subscribeClobTokens(tokenIds) {
    const newTokens = tokenIds.filter(t => !this.subscribedTokens.has(t));
    if (newTokens.length === 0) return;
    newTokens.forEach(t => this.subscribedTokens.add(t));
    this._sendClobSubscription(newTokens);
  }

  _sendClobSubscription(tokenIds) {
    if (!this.clobWs || this.clobWs.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ assets_ids: tokenIds, type: 'subscribe' });
    this.clobWs.send(msg);
    console.log(`[OracleLag] CLOB WS subscribed to ${tokenIds.length} tokens`);
  }

  /**
   * Get real-time CLOB ask price for a token from in-memory cache.
   * Falls back to HTTP only if WS price is missing or stale (>10s old).
   */
  async _getClobPrice(tokenId) {
    const cached = this.clobPrices[tokenId];
    const now = Date.now();
    if (cached && cached.ask != null) {
      const ageMs = now - cached.ts;
      const lastChangeMs = cached.lastPriceChangeTs ? now - cached.lastPriceChangeTs : Infinity;
      // Trust WS if we've received a confirmed price_change event within 30s.
      // price_change events come from the live stream — any ask value including
      // 0.95+ is real (e.g. a DOWN market at 0.97 during a flash crash is legitimate).
      // Only fall back to HTTP for tokens that only have a snapshot with no subsequent
      // price_change confirmation — those are the cases where 0.97+ is often a stale
      // limit order artifact rather than real liquidity.
      if (lastChangeMs < 30_000) return cached.ask;
      // Snapshot-only (no price_change yet): apply the 0.95 artifact filter.
      if (ageMs < 15_000 && cached.ask < 0.95) return cached.ask;
    }
    // Fallback: HTTP (stale/missing WS data or snapshot-only token with suspicious price)
    try {
      const res = await axios.get('https://clob.polymarket.com/price', {
        params: { token_id: tokenId, side: 'buy' },
        timeout: 2000,
      });
      const p = parseFloat(res.data?.price);
      if (!isNaN(p)) {
        if (!this.clobPrices[tokenId]) this.clobPrices[tokenId] = {};
        this.clobPrices[tokenId].ask = p;
        this.clobPrices[tokenId].ts  = now;
        // HTTP fetch does not set lastPriceChangeTs — only WS price_change events do.
      }
      return isNaN(p) ? null : p;
    } catch { return null; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Binance WebSocket — real-time spot prices
  // ─────────────────────────────────────────────────────────────────────────────

  _connectBinance() {
    const pairs = ['btcusdt', 'ethusdt', 'dogeusdt'];
    // aggTrade fires on every individual trade (sub-second) vs miniTicker's 1s interval.
    // This lets us detect the very first tick of a price move ~500ms earlier.
    const streams = pairs.map(s => `${s}@aggTrade`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => console.log('[OracleLag] Binance WS connected (aggTrade)'));

    this.ws.on('message', async (data) => {
      try {
        const msg   = JSON.parse(data);
        const trade = msg.data;
        if (!trade?.p || !trade?.s) return;

        const symbol = trade.s.replace('USDT', '');
        const price  = parseFloat(trade.p);
        if (isNaN(price)) return;

        this.lastBinanceTick = Date.now();
        this.prices[symbol] = { current: price, ts: Date.now() };
        this._pushPriceHistory(symbol, price);

        if (!this.windowOpenPrices.has(symbol)) {
          this.windowOpenPrices.set(symbol, price);
        }
        if (!this.windowOpenPrices15m.has(symbol)) {
          this.windowOpenPrices15m.set(symbol, price);
        }

        // Post-reconnect warm-up: require 3 consecutive ticks before resuming signals
        if (this._wsSuspended) {
          this._freshTickCount++;
          if (this._freshTickCount >= 3) {
            this._wsSuspended      = false;
            this._wsSuspendAlerted = false;
            this._freshTickCount   = 0;
            console.log('[OracleLag] Binance WS feed restored — resuming signal evaluation');
            tg.send('✅ Binance feed restored — signals resumed.');
          }
          return; // don't evaluate until warm-up complete
        }

        if (this.markets.size === 0) return;

        // Move-triggered throttle: evaluate only when price moved ≥0.02% OR ≥150ms elapsed.
        // This gives sub-second detection of significant moves without hammering the eval loop
        // on every single trade tick (which can be 100s/second for BTC).
        const lastTs    = this.lastEvalTs[symbol]    || 0;
        const lastPrice = this.lastEvalPrice[symbol] || price;
        const movePct   = Math.abs((price - lastPrice) / lastPrice) * 100;
        const elapsed   = Date.now() - lastTs;

        if (movePct < 0.02 && elapsed < 150) return;

        this.lastEvalTs[symbol]    = Date.now();
        this.lastEvalPrice[symbol] = price;

        await this._checkOpportunity(symbol, price);
      } catch { /* ignore parse errors */ }
    });

    this.ws.on('error', err => console.warn('[OracleLag] Binance WS error:', err.message));
    this.ws.on('close', () => {
      if (this.running) setTimeout(() => this._connectBinance(), 3000);
    });
  }

  /**
   * Watchdog — three states:
   *  < 20s  → healthy (aggTrade can be slow during low-activity periods)
   *  20–45s → SUSPEND signal evaluation, alert once via Telegram
   *  > 45s  → force reconnect, reset warm-up counter
   */
  _startBinanceWatchdog() {
    this.lastBinanceTick = Date.now(); // seed so we don't fire immediately on start
    setInterval(() => {
      if (!this.running) return;
      const silentMs = Date.now() - this.lastBinanceTick;

      if (silentMs > 45_000) {
        // State 3: force reconnect
        console.warn(`[OracleLag] Binance WS silent for ${Math.round(silentMs / 1000)}s — forcing reconnect`);
        this._wsSuspended      = true;
        this._wsSuspendAlerted = false; // allow fresh alert after reconnect restore
        this._freshTickCount   = 0;
        try { this.ws?.terminate(); } catch { /* ignore */ }
        this._connectBinance();
      } else if (silentMs > 20_000) {
        // State 2: suspend — stale feed, don't trade
        if (!this._wsSuspended) {
          this._wsSuspended = true;
          this._freshTickCount = 0;
        }
        if (!this._wsSuspendAlerted) {
          this._wsSuspendAlerted = true;
          console.warn(`[OracleLag] Binance WS stale ${Math.round(silentMs / 1000)}s — signals SUSPENDED`);
          tg.send(`⚠️ Binance feed stale (${Math.round(silentMs / 1000)}s) — signals suspended until feed recovers.`);
        }
      }
      // < 20s: healthy, no action needed
    }, 5_000); // check every 5s for tighter suspension detection
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rolling price history (for spike detection)
  // ─────────────────────────────────────────────────────────────────────────────

  _pushPriceHistory(symbol, price) {
    if (!this.priceHistory[symbol]) this.priceHistory[symbol] = [];
    const now = Date.now();
    this.priceHistory[symbol].push({ price, ts: now });
    const cutoff = now - 600_000;  // 10-min buffer — needed for 8-min prior-context check
    const hist = this.priceHistory[symbol];
    let i = 0;
    while (i < hist.length - 1 && hist[i].ts < cutoff) i++;
    if (i > 0) this.priceHistory[symbol] = hist.slice(i);
  }

  /** % price move over the last `secondsAgo` seconds. Synchronous. */
  _getRecentMove(symbol, secondsAgo) {
    const hist = this.priceHistory[symbol];
    if (!hist || hist.length < 2) return 0;
    const targetTs = Date.now() - secondsAgo * 1000;
    let oldEntry = null;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].ts <= targetTs) { oldEntry = hist[i]; break; }
    }
    if (!oldEntry) return 0;
    const current = hist[hist.length - 1];
    return ((current.price - oldEntry.price) / oldEntry.price) * 100;
  }

  _historyAge(symbol) {
    const hist = this.priceHistory[symbol];
    if (!hist || hist.length < 2) return 0;
    return (hist[hist.length - 1].ts - hist[0].ts) / 1000;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Market discovery
  // ─────────────────────────────────────────────────────────────────────────────

  async _refreshCryptoMarkets() {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const GAMMA = this.config.gammaHost || 'https://gamma-api.polymarket.com';
    let found = 0;

    for (const [id, m] of this.markets) {
      if (m._endsAtMs && m._endsAtMs < now - 60000) {
        this.markets.delete(id);
        this.tradedMarkets.delete(id);
      }
    }

    // Timeframe definitions: slug suffix, window interval (sec), how many future windows to prefetch
    const TIMEFRAMES = [
      { name: '5m',  intervalSec: 300,   lookAhead: 2 },
      { name: '15m', intervalSec: 900,   lookAhead: 1 },
      { name: '1h',  intervalSec: 3600,  lookAhead: 0 },
      { name: '4h',  intervalSec: 14400, lookAhead: 0 },
    ];

    const fetches = [];
    for (const asset of Object.keys(ASSET_SYMBOL_MAP)) {
      for (const tf of TIMEFRAMES) {
        if (DISABLED_COMBOS.has(`${asset}-${tf.name}`)) continue;
        const windowStart = Math.floor(nowSec / tf.intervalSec) * tf.intervalSec;
        for (let i = 0; i <= tf.lookAhead; i++) {
          const ts = windowStart + i * tf.intervalSec;
          fetches.push({ slug: `${asset}-updown-${tf.name}-${ts}`, asset, timeframe: tf.name });
        }
      }
    }

    const newTokenIds = [];

    await Promise.all(fetches.map(async ({ slug, asset, timeframe }) => {
      try {
        const res = await axios.get(`${GAMMA}/markets`, { params: { slug }, timeout: 8000 });
        const arr = res.data;
        const m = Array.isArray(arr) ? arr[0] : arr;
        if (!m || !m.active || m.closed || !m.acceptingOrders) return;

        const endsAtMs = m.endDate ? new Date(m.endDate).getTime() : null;
        if (!endsAtMs) return;
        if (endsAtMs < now - 10000) return;
        if (endsAtMs > now + 48 * 60 * 60 * 1000) return;

        const conditionId = m.conditionId;
        if (this.markets.has(conditionId)) return;

        let tokenIds = m.clobTokenIds;
        if (typeof tokenIds === 'string') { try { tokenIds = JSON.parse(tokenIds); } catch { return; } }
        if (!tokenIds || tokenIds.length < 2) return;

        let prices = m.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = ['0.5','0.5']; } }

        const symbol = ASSET_SYMBOL_MAP[asset];
        m.condition_id = conditionId;
        m._symbol    = symbol;
        m._timeframe = timeframe;
        m._upToken   = { token_id: tokenIds[0], outcome: 'Up',   price: parseFloat(prices[0]) || 0.5 };
        m._downToken = { token_id: tokenIds[1], outcome: 'Down', price: parseFloat(prices[1]) || 0.5 };
        m._endsAtMs  = endsAtMs;
        m._startsAtMs = m.eventStartTime ? new Date(m.eventStartTime).getTime() : null;

        this.markets.set(conditionId, m);
        found++;
        newTokenIds.push(tokenIds[0], tokenIds[1]);

        if (!this.windowOpenPrices.has(symbol) && this.prices[symbol]) {
          this.windowOpenPrices.set(symbol, this.prices[symbol].current);
        }
        if (!this.windowOpenPrices15m.has(symbol) && this.prices[symbol]) {
          this.windowOpenPrices15m.set(symbol, this.prices[symbol].current);
        }
      } catch { /* skip */ }
    }));

    // Subscribe new tokens to CLOB WebSocket
    if (newTokenIds.length > 0) this._subscribeClobTokens(newTokenIds);

    const by5m  = [...this.markets.values()].filter(m => m._timeframe === '5m').length;
    const by15m = [...this.markets.values()].filter(m => m._timeframe === '15m').length;
    const by1h  = [...this.markets.values()].filter(m => m._timeframe === '1h').length;
    const by4h  = [...this.markets.values()].filter(m => m._timeframe === '4h').length;
    console.log(`[OracleLag] Tracking ${this.markets.size} markets (${by5m} 5m, ${by15m} 15m, ${by1h} 1h, ${by4h} 4h) | ${found} new`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Signal detection
  // ─────────────────────────────────────────────────────────────────────────────

  async _checkOpportunity(symbol, currentPrice) {
    if (!this.running || this.paused || !this._canTrade()) return;
    if (this._wsSuspended) return; // Binance feed stale — don't act on stale prices

    // No time gate — signal filters (spike ≥0.25%, window ≥0.50%, reversal CLOB mismatch)
    // are strong enough to prevent bad trades during quiet hours. Markets run 24/7.
    const now = Date.now();
    for (const [conditionId, market] of this.markets) {
      if (this.activePositions >= this.maxConcurrentPositions) break;
      if (market._symbol !== symbol) continue;
      if (this.tradedMarkets.has(conditionId)) continue;
      if (market._endsAtMs && market._endsAtMs < now + 45000) continue; // need ≥45s left for GTC fill
      if (this.fokCooldown[conditionId] && now - this.fokCooldown[conditionId] < 30000) continue; // 30s cooldown after FOK kill
      await this._evaluateMarket(market, symbol, currentPrice);
    }
  }

  async _evaluateMarket(market, symbol, spotPrice) {
    // Race guard: if this market is already mid-evaluation on a prior tick, skip.
    // Prevents duplicate orders when multiple Binance ticks arrive within the same async await.
    const cid = market.condition_id;
    if (this.evaluatingMarkets.has(cid)) return;
    this.evaluatingMarkets.add(cid);
    try {
      const now = Date.now();
      if (market._startsAtMs && market._startsAtMs > now) return;

      // For 15m/1h/4h markets: oracle lag only applies in the final 8 minutes.
      // Before that, there's too much time left for the edge to survive.
      const timeframe = market._timeframe || '5m';
      if (timeframe !== '5m' && market._endsAtMs) {
        const msToExpiry = market._endsAtMs - now;
        if (msToExpiry > 8 * 60 * 1000) {
          // Emit a lightweight 'waiting' tick so the dashboard shows the market exists
          // Throttle to once per 10s per market to avoid flooding the UI
          const waitKey = market.condition_id;
          if (!this._waitingTickTs) this._waitingTickTs = {};
          if (!this._waitingTickTs[waitKey] || now - this._waitingTickTs[waitKey] > 10000) {
            this._waitingTickTs[waitKey] = now;
            const pctWindow = ((spotPrice - (this.windowOpenPrices15m.get(symbol) || this.windowOpenPrices.get(symbol) || spotPrice)) / (this.windowOpenPrices15m.get(symbol) || this.windowOpenPrices.get(symbol) || spotPrice)) * 100;
            this.emit('scan_tick', {
              symbol, timeframe, path: '—', pctWindow, spike60: 0, spike15: 0, spike10: 0,
              clobPrice: null, maxClobPrice: null, direction: null, status: 'waiting',
              msLeft: msToExpiry, marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : '',
              marketSlug: market.slug || '',
            });
          }
          return; // too early — check back later
        }
      }

      const upToken   = market._upToken;
      const downToken = market._downToken;

      // ── Window move — use correct reference for each timeframe ──────────────
      // 5m markets: reference resets every 5 minutes (correct)
      // 15m markets: reference resets every 15 minutes (was wrong — was using 5m ref)
      const windowRef  = timeframe === '15m'
        ? (this.windowOpenPrices15m.get(symbol) || this.windowOpenPrices.get(symbol) || spotPrice)
        : (this.windowOpenPrices.get(symbol) || spotPrice);
      const windowOpen = windowRef;
      const pctWindow  = ((spotPrice - windowOpen) / windowOpen) * 100;

      // ── Spike detection (synchronous, zero latency) ────────────────────────
      const histAge = this._historyAge(symbol);
      const spike60 = histAge >= 25 ? this._getRecentMove(symbol, 60) : 0;
      const spike30 = histAge >= 15 ? this._getRecentMove(symbol, 30) : 0;
      const spike15 = histAge >=  5 ? this._getRecentMove(symbol, 15) : 0;
      const spike10 = histAge >=  3 ? this._getRecentMove(symbol, 10) : 0;

      // Anti-bounce filter REMOVED — 90-day backtest showed net -$24,868 impact:
      // blocked 646 wins to save only 29 losses. Broad-market guard (≥4 assets) and
      // velocity check (CLOB moving ≥0.02 in 5s) handle the real bounce cases.

      // ── Both CLOB prices from WS cache (0ms) ──────────────────────────────
      // Reject ask ≥ 0.95: likely a stale high limit order from the WS snapshot, not real liquidity.
      const _upRaw   = this.clobPrices[upToken.token_id]?.ask;
      const _downRaw = this.clobPrices[downToken.token_id]?.ask;
      const upClobAsk   = (_upRaw   != null && _upRaw   < 0.95) ? _upRaw   : null;
      const downClobAsk = (_downRaw != null && _downRaw < 0.95) ? _downRaw : null;

      // ── PATH C: REVERSAL ───────────────────────────────────────────────────
      // CLOB committed strongly to one direction, but BTC has actually moved opposite.
      // e.g. CLOB shows UP=0.80 (BTC was up early), but BTC is now -0.25% from window open.
      // → Buy DOWN cheap (0.20 ask) before AMM catches the reversal.
      // Conviction threshold: stale side > 0.65, disagreement ≥ 0.20%.
      let isReversal = false;
      let reversalStaleSidePrice = 0;
      let reversalDirection = null;

      if (upClobAsk != null && downClobAsk != null) {
        // REVERSAL: CLOB strongly committed to one side but spot has moved opposite.
        // Thresholds tuned from live data (Apr 14-22 2026):
        //   stale ≥ 0.70: lowered from 0.75 — ETH stales at 0.71 consistently and was being
        //     excluded. At 0.70 we catch ETH reversals while still requiring meaningful CLOB bias.
        //   window ≥ 0.12%: lowered from 0.15% — 5-day live scan showed no signals reaching
        //     threshold on ranging days. 0.12% is still above noise floor.
        //   spike60 ≥ 0.05%, same direction: confirms momentum is current, not residual.
        const reversalWindowThresh = 0.12;
        const reversalSpike60Min   = 0.05;
        const reversalStaleThresh  = 0.70;
        if (upClobAsk > reversalStaleThresh && pctWindow < -reversalWindowThresh && Math.abs(spike60) >= reversalSpike60Min && spike60 < 0) {
          isReversal = true;
          reversalDirection = 'DOWN';
          reversalStaleSidePrice = upClobAsk;
        } else if (downClobAsk > reversalStaleThresh && pctWindow > reversalWindowThresh && Math.abs(spike60) >= reversalSpike60Min && spike60 > 0) {
          isReversal = true;
          reversalDirection = 'UP';
          reversalStaleSidePrice = downClobAsk;
        }
      }

      // ── PATH A / B / D: spike-led, window-led, early ─────────────────────────
      const spikeDir60 = (pctWindow > 0 && spike60 > 0) || (pctWindow < 0 && spike60 < 0);
      // Window age: how far into the current 5-min window we are (ms).
      // SPIKE and WINDOW paths require ≥90s into the window — early moves often reverse.
      // REVERSAL and EARLY are exempt (different mechanics).
      const windowAgeMs = now - (Math.floor(now / 300000) * 300000);
      // PATH A (SPIKE): DISABLED for live trading — ~40% WR, negative PnL.
      // wouldBeSpike is still computed and logged so we can evaluate from data later
      // whether re-enabling is justified. After 50+ REVERSAL trades, compare SPIKE
      // signal outcomes (from signal_log.json) against REVERSAL to make the call.
      // PATH B thresholds vary by timeframe:
      // 5m/15m: window ≥ 0.70% + spike60 ≥ 0.20%
      // 1h: window ≥ 1.50% + spike60 ≥ 0.35% (bigger threshold — 1h moves are noisier)
      // 4h: window ≥ 1.00% + spike60 ≥ 0.35% (0.70% is noise over 4h)
      // For non-5m markets the 8-min gate ensures we're always deep enough in the window,
      // so skip the windowAgeMs >= 90000 check (it's a 5m concept and irrelevant here).
      const windowThresh  = timeframe === '4h' ? 1.00 : timeframe === '1h' ? 1.50 : 0.70;
      const spike60Thresh = timeframe === '4h' || timeframe === '1h' ? 0.35 : 0.20;
      const windowAgeOk   = timeframe === '5m' ? windowAgeMs >= 60000 : true;
      // SPIKE re-enabled: latency p99=497ms < 600ms threshold confirmed from 11 live trades.
      // 90-day backtest: 3,140 signals, 98.6% WR, all spike magnitude buckets edge-positive.
      // Floor: |spike60| ≥ 0.20% + |pctWindow| ≥ 0.20% (all buckets showed edge in backtest).
      const isSpikeLed   = Math.abs(spike60) >= 0.20 && Math.abs(pctWindow) >= 0.20 && spikeDir60 && windowAgeOk;
      const wouldBeSpike = isSpikeLed; // kept for path label logic
      const isWindowLed   = Math.abs(pctWindow) >= windowThresh && Math.abs(spike60) >= spike60Thresh && spikeDir60 && windowAgeOk;
      // PATH D (EARLY): disabled — 0W/3L track record (-$24), all losses.
      // Early spikes fire before the window has enough price history to confirm direction.
      // SPIKE and WINDOW paths (which require ≥90s window age) have much better fill quality.
      const spikeDir15  = false;
      const spikeDir10  = false;
      const earlyAgree  = false;
      const isEarlySpike = false;

      // PATH E (LATE CONVICTION): enter 3+ minutes into a 5m window when direction is confirmed.
      // Source: top Polymarket whale trader analysis (487 trades, +$17,929, 91% WR by market):
      //   - 85% of their trades enter at >180s with avg CLOB 0.58 → near-certain settlement
      //   - They completely skip 60-180s (noise zone); our bot should too
      //   - At 3min with ≥0.35% confirmed move, the direction resolves correctly ~75-80% of time
      //   - Breakeven at CLOB 0.68: need 73% WR — lowered threshold helps in consolidation
      //   - Window threshold lowered 0.50% → 0.35% to catch smaller confirmed moves in tight markets
      // Only 5m markets: 15m/4h windows are too long for the "3min confirmation" logic to hold.
      const isLateConviction = timeframe === '5m'
        && windowAgeMs >= 180_000                   // ≥ 3 minutes in (120s left to settle)
        && Math.abs(pctWindow) >= 0.35              // ≥ 0.35% confirmed directional move (was 0.50%)
        && spikeDir60                               // 60s spike agrees — direction not reversing
        && !isReversal;                             // reversal handles its own late logic

      // ── Multi-asset correlation filter ────────────────────────────────────────
      // If ≥4 assets are all moving the same direction (>0.15% window move), it's a
      // broad market pump/dump — market makers reprice everything simultaneously and the
      // oracle lag edge shrinks. Skip to avoid chasing efficient moves.
      const assetDir = pctWindow > 0 ? 1 : -1;
      // Use 5m window reference for broad correlation (consistent cross-asset comparison)
      const broadMoveCount = [...this.windowOpenPrices.entries()].filter(([sym, wo]) => {
        const cur = this.prices[sym]?.current;
        if (!cur || !wo) return false;
        const mv = ((cur - wo) / wo) * 100;
        return assetDir > 0 ? mv > 0.15 : mv < -0.15;
      }).length;
      if (broadMoveCount >= 4 && !isReversal) {
        // Broad market move detected — CLOB efficiency high; skip non-reversal signals
        return;
      }

      // ── Always emit scan_tick so the dashboard scanner shows live data ───────
      // Use the dominant direction (pctWindow) for display; CLOB from WS cache.
      const btcDirection    = pctWindow > 0 ? 'UP' : 'DOWN';
      const displayDir      = isReversal ? reversalDirection : btcDirection;
      const displayClobRaw  = displayDir === 'UP' ? upClobAsk : downClobAsk;
      const displayClob     = displayClobRaw ?? 0.5;
      const anySignal       = isReversal || isSpikeLed || isWindowLed || isEarlySpike || isLateConviction;
      const displayMax      = 0.42; // simplified for display
      const marketSlugEarly = market.slug || '';
      const marketUrlEarly  = marketSlugEarly ? `https://polymarket.com/event/${marketSlugEarly}` : '';
      const msLeftEarly     = market._endsAtMs ? market._endsAtMs - Date.now() : 0;
      this.emit('scan_tick', {
        symbol, path: anySignal ? 'SIGNAL' : 'watching',
        pctWindow, spike60, spike15, spike10,
        clobPrice: displayClob, maxClobPrice: displayMax,
        direction: displayDir,
        status: (anySignal && displayClob < displayMax) ? 'ready' : 'watching',
        msLeft: msLeftEarly, marketUrl: marketUrlEarly, marketSlug: marketSlugEarly,
        timeframe,
      });

      if (!isReversal && !isSpikeLed && !isWindowLed && !isEarlySpike && !isLateConviction) return;

      // ── Determine final direction & target token ───────────────────────────
      const targetDirection = isReversal ? reversalDirection : btcDirection;
      const targetToken     = targetDirection === 'UP' ? upToken : downToken;

      // Build path label
      const pathParts = [];
      if (isReversal)        pathParts.push('REVERSAL');
      if (isEarlySpike && btcDirection === targetDirection) pathParts.push('EARLY');
      if (isSpikeLed   && btcDirection === targetDirection) pathParts.push('SPIKE');
      if (isWindowLed  && btcDirection === targetDirection) pathParts.push('WINDOW');
      if (isLateConviction)  pathParts.push('LATE');
      const path = pathParts.join('+') || 'REVERSAL';

      // ── CLOB price for target token (0ms from cache) ──────────────────────
      const clobPrice = await this._getClobPrice(targetToken.token_id);
      if (!clobPrice) { console.log(`[OracleLag] CLOB price unavailable for ${symbol} ${targetDirection}`); return; }

      const clobCacheTs  = this.clobPrices[targetToken.token_id]?.ts;
      const clobAgeMs    = clobCacheTs ? Date.now() - clobCacheTs : Infinity;
      const wsAge        = clobCacheTs ? `${(clobAgeMs / 1000).toFixed(1)}s ago` : 'HTTP';

      // ── Max CLOB thresholds ───────────────────────────────────────────────────
      // REVERSAL:        buy the cheap side — cap scales with how wrong the stale side is
      // LATE CONVICTION: raised 0.68→0.82 — backtest WR 85%, breakeven at 0.82 = 82% WR → +EV
      //                  5-day live data showed LATE signals only appearing at CLOB 0.98-0.99:
      //                  those are still blocked (0.82 cap). Catches the intermediate 0.68-0.82 range.
      // SPIKE/WINDOW:    dynamic by move magnitude — very large moves have near-certain direction:
      //   |window| ≥ 10%: cap 0.82 (need 82% WR — at 10%+ move, direction resolves >95%)
      //   |window| ≥  5%: cap 0.75 (need 75% WR — at  5%+ move, direction resolves >90%)
      //   |window| ≥  2%: cap 0.58 (need 58% WR — at  2%+ move, direction resolves >75%)
      //   |window| <  2%: sub-tiers by |spike60| — stronger short-term spike = more lag remaining:
      //     |spike60| ≥ 1.0%: cap 0.65 (strong 60s momentum, book still catching up)
      //     |spike60| ≥ 0.50%: cap 0.50 (moderate spike, some lag expected)
      //     base:             cap 0.38 (weak signal — strict filter)
      const absPctWindow = Math.abs(pctWindow);
      const absSpike60   = Math.abs(spike60);
      const maxClobPrice = isReversal
        ? (reversalStaleSidePrice > 0.85 ? 0.38 : reversalStaleSidePrice > 0.75 ? 0.32 : 0.26)
        : isLateConviction ? 0.82
        : absPctWindow >= 10.0 ? 0.82
        : absPctWindow >= 5.0  ? 0.75
        : absPctWindow >= 2.0  ? 0.58
        : absSpike60 >= 1.0    ? 0.65
        : absSpike60 >= 0.50   ? 0.50
        : 0.38;

      // CLOB floor: orders below 0.32 on SPIKE/WINDOW almost never fill (book too thin at low prices).
      // Two confirmed unfilled cancels on DOGE SPIKE at 0.27-0.28 (Apr 25-26).
      // REVERSAL buys the cheap side directly — low CLOB is the signal, keep 0.22/0.28 floor.
      // LATE has its own floor check below.
      const clobFloor = isReversal
        ? (symbol === 'DOGE' ? 0.22 : 0.28)          // REVERSAL: low CLOB is the edge
        : isLateConviction ? 0.28                      // LATE: handled separately below
        : 0.32;                                        // SPIKE/WINDOW: below 0.32 = no book depth
      if (clobPrice < clobFloor && !isLateConviction) {
        console.log(`[OracleLag] CLOB ${targetDirection}=${clobPrice.toFixed(3)} < ${clobFloor} floor (${symbol}) — skip`);
        this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft: market._endsAtMs - Date.now(), blocked_by: 'CLOB_FLOOR', traded: false, tokenId: targetToken.token_id });
        return;
      }
      if (isLateConviction && !isWindowLed && clobPrice < 0.40) {
        console.log(`[OracleLag] LATE floor: CLOB ${targetDirection}=${clobPrice.toFixed(3)} < 0.40 at ${Math.round(windowAgeMs/1000)}s — move not reflected in book, skip`);
        this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft: market._endsAtMs - Date.now(), blocked_by: 'LATE_FLOOR', traded: false, tokenId: targetToken.token_id });
        return;
      }

      // PATH D requires very fresh CLOB (< 1.5s) — tightened from 2s.
      const isEarlyOnly = isEarlySpike && !isSpikeLed && !isWindowLed && !isReversal;

      const earlyTag = isEarlyOnly ? ` 15s=${spike15>=0?'+':''}${spike15.toFixed(3)}% 10s=${spike10>=0?'+':''}${spike10.toFixed(3)}%` : '';
      console.log(`[OracleLag] [${path}][${timeframe}] ${symbol} window=${pctWindow>=0?'+':''}${pctWindow.toFixed(3)}% 60s=${spike60>=0?'+':''}${spike60.toFixed(3)}%${earlyTag} | CLOB ${targetDirection}=${clobPrice.toFixed(3)} max=${maxClobPrice} age=${wsAge}${isReversal ? ` | stale=${reversalStaleSidePrice.toFixed(3)}` : ''}`);

      // Compute msLeft BEFORE emitting scan_tick so the dashboard status is accurate.
      // Previously msLeft was checked after scan_tick, causing dashboard to show 🔥 FIRE
      // even when the bot would immediately skip due to insufficient window time.
      const msLeft   = market._endsAtMs - now;
      // Per-timeframe minimum: 15m/4h need more runway than 5m.
      // 15m: 200s — avoids entering when 80%+ of window has elapsed (low edge, high variance)
      // 4h:  300s — avoids entering in the final 5 min of a 4h window
      const minMsLeft = timeframe === '4h' ? 300_000 : timeframe === '15m' ? 200_000 : 45_000;
      const tooLate   = msLeft < minMsLeft;
      const clobOver = clobPrice >= maxClobPrice;
      const scanStatus = (clobOver || tooLate) ? 'skip' : 'ready';

      const marketSlug = market.slug || '';
      const marketUrl  = marketSlug ? `https://polymarket.com/event/${marketSlug}` : '';
      this.emit('scan_tick', { symbol, path, pctWindow, spike60, spike15, spike10, clobPrice, maxClobPrice, direction: targetDirection, status: scanStatus, msLeft, marketUrl, marketSlug, timeframe });

      if (clobOver) {
        console.log(`[OracleLag] CLOB at ${clobPrice.toFixed(3)} ≥ max ${maxClobPrice} — skip`);
        this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft, blocked_by: 'CLOB_OVER', traded: false, tokenId: targetToken.token_id });
        // Near-miss alert: CLOB just slightly above threshold (within 0.06) — market is heating up
        // Skip post-settlement noise (clob ≥ 0.90) and enforce 60s cooldown per market
        const nearMissGap = clobPrice - maxClobPrice;
        const lastNearMiss = this._nearMissCooldown[market.condition_id] || 0;
        if (nearMissGap <= 0.06 && clobPrice < 0.90 && (Date.now() - lastNearMiss) > 60000) {
          this._nearMissCooldown[market.condition_id] = Date.now();
          tg.nearMissAlert({ symbol, direction: targetDirection, path, timeframe, clobPrice, maxClobPrice, pctWindow, msLeft });
        }
        return;
      }

      if (tooLate) {
        console.log(`[OracleLag] ${symbol} ${targetDirection} — only ${(msLeft/1000).toFixed(0)}s left, skip`);
        this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft, blocked_by: 'TOO_LATE', traded: false, tokenId: targetToken.token_id });
        return;
      }

      // ── CLOB velocity check — skip if book is already repricing ─────────
      // Tightened: ≥0.02 delta in 5s (was 0.04/3s). MMs move in 0.02 increments;
      // catching earlier repricing means we skip more marginal fills and only trade
      // when the CLOB is clearly stale (no movement at all in the last 5s).
      const clobEntry  = this.clobPrices[targetToken.token_id];
      const prevAsk    = clobEntry?.prevAsk;
      const prevAskAge = clobEntry ? (Date.now() - clobEntry.prevAskTs) : 9999;
      if (prevAsk != null && prevAskAge < 5000) {
        const clobDelta = Math.abs(clobPrice - prevAsk);
        if (clobDelta >= 0.02) {
          console.log(`[OracleLag] CLOB repricing (${prevAsk.toFixed(3)}→${clobPrice.toFixed(3)} in ${(prevAskAge/1000).toFixed(1)}s) — skip`);
          this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft, blocked_by: 'VELOCITY', traded: false, tokenId: targetToken.token_id });
          return;
        }
      }

      const question = market.question?.slice(0, 65);

      // AI sentiment check removed — adds 2-3s HTTP latency before order submission.
      // The CLOB reprices within that window, turning profitable fills into fair-value
      // buys. Direction signal (99%+ win rate in backtest) is sufficient; speed is the edge.
      const finalPath = path;

      // ── Window-reference plausibility cross-check ─────────────────────────────
      // Given the Binance pctWindow move and time remaining, estimate the minimum
      // probability P(direction) a well-informed market should price the token at.
      // If the actual CLOB is far below that estimate (divergence > 0.45), the
      // 15m windowRef is likely misaligned with the Polymarket oracle's snapshot
      // price — meaning the "big move" we think we see may be measured from the
      // wrong baseline.
      // Seen on Apr 27 DOGE: pctWindow=-20% (ref misaligned) but CLOB DOWN=0.13
      // for 90s → market correctly said UP, our ref was wrong.
      // We still allow the trade (CLOB repricing is real), but warn loudly.
      const _minutesLeft   = Math.max(0.5, msLeft / 60000);
      const _sigmaRemain   = 0.020 * Math.sqrt(_minutesLeft);         // 2%/min vol estimate
      const _z             = Math.abs(pctWindow) / _sigmaRemain;
      const _expectedProb  = Math.min(0.97, 0.5 + 0.40 * Math.min(1, _z / 2.5));
      const refDivergence  = parseFloat((_expectedProb - clobPrice).toFixed(3));
      const refSuspect     = refDivergence > 0.45;

      if (refSuspect) {
        console.warn(`[OracleLag] ⚠ windowRef SUSPECT: pctWindow=${(pctWindow*100).toFixed(1)}% implies P(${targetDirection})≈${_expectedProb.toFixed(2)}, CLOB=${clobPrice.toFixed(3)} (divergence=${refDivergence}). 15m ref may be misaligned with oracle.`);
      }

      console.log(`[OracleLag] *** OPPORTUNITY [${finalPath}]: ${question}`);
      console.log(`            BUY ${targetDirection} @ ${clobPrice.toFixed(3)} (max=${maxClobPrice}) | ${(msLeft/1000).toFixed(0)}s left${refSuspect ? ' ⚠ REF_SUSPECT' : ''}`);

      this.emit('opportunity', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        symbol, spotPrice, windowOpen, pctMove: pctWindow, spike60, spike30, spike15, spike10, path: finalPath,
        direction: targetDirection, tokenId: targetToken.token_id, side: targetDirection,
        price: clobPrice, expectedEdge: (maxClobPrice - clobPrice).toFixed(3), msLeft,
        refDivergence, refSuspect,
      });

      const signalTs = Date.now(); // ← latency measurement starts here
      // Pre-warm clob-client tick-size + fee-rate cache now, in parallel with
      // the remaining sync work below. By the time placeBuyOrder runs, the HTTP
      // calls are already done and createOrder only needs to sign locally.
      this.poly.prewarmOrder(targetToken.token_id);
      this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path: finalPath, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft, blocked_by: null, traded: true, tokenId: targetToken.token_id, refDivergence, refSuspect });
      this.tradedMarkets.add(market.condition_id);
      await this._executeTrade(market, targetToken.token_id, clobPrice, targetDirection, question, pctWindow, isReversal ? reversalStaleSidePrice : null, isEarlyOnly, finalPath, signalTs, symbol, refDivergence, refSuspect);

    } catch (err) {
      console.error('[OracleLag] Evaluate error:', err.message);
      console.error('[OracleLag] Stack:', String(err.stack || 'NO STACK').split('\n').slice(0,6).join(' | '));
    } finally {
      this.evaluatingMarkets.delete(cid);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trade execution
  // ─────────────────────────────────────────────────────────────────────────────

  async _executeTrade(market, tokenId, price, direction, question, pctWindow = 0.5, reversalStalePrice = null, isEarlyOnly = false, path = '', signalTs = Date.now(), symbol = '', refDivergence = 0, refSuspect = false) {
    // Use cached balance (refreshed every 20s) — avoids HTTP round-trip before every order.
    // If cache is >60s stale, fetch fresh as a safety net.
    let balance = this._cachedBalance;
    if (balance == null || Date.now() - this._balanceFetchTs > 60000) {
      await this._refreshBalance();
      balance = this._cachedBalance || 0;
    }
    const reserve   = this.config.reserveUsdc || 5;
    const available = balance - reserve - this.committedUsdc;
    if (available < 5) {
      console.log(`[OracleLag] Balance too low ($${balance.toFixed(2)}) — skipping`);
      // Keep tradedMarkets set — balance won't recover within this market window
      return;
    }

    // ── Daily counters (reset at UTC midnight) ────────────────────────────────
    const todayStr = new Date().toISOString().slice(0, 10);
    if (this.dayString !== todayStr) {
      // Send previous day's summary before resetting counters
      if (this.dayString) {
        const fs = require('fs'), path = require('path');
        let signalCount = 0;
        try {
          const lines = fs.readFileSync(path.join(__dirname, '..', 'signal_log.jsonl'), 'utf8').trim().split('\n');
          const yesterday = this.dayString;
          signalCount = lines.filter(l => { try { return JSON.parse(l).date?.startsWith(yesterday); } catch { return false; } }).length;
        } catch { /* no signal log yet */ }
        tg.dailySummary({ date: this.dayString, tradeCount: this.dayTradeCount, maxTrades: this.config.maxDailyTrades || 3, balance, startBalance: this.dayStartBalance, signalCount });
      }
      this.dayString         = todayStr;
      this.dayStartBalance   = balance;
      this.dayTradeCount     = 0;
      this.dayWinCount       = 0;
      this.dayLossCount      = 0;
      this.consecutiveLosses = 0;
      this.dayTradeString    = todayStr;
      this._persistDayState();
      console.log(`[OracleLag] New day (${todayStr}) — counters reset. Start balance: $${balance.toFixed(2)}`);
    }
    if (!this.dayStartBalance) { this.dayStartBalance = balance; this._persistDayState(); }

    // ── Daily trade cap ───────────────────────────────────────────────────────
    const maxDailyTrades = this.config.maxDailyTrades || 3;
    if (this.dayTradeCount >= maxDailyTrades) {
      console.log(`[OracleLag] ⛔ DAILY CAP: ${this.dayTradeCount}/${maxDailyTrades} trades today — pausing until midnight`);
      return;
    }

    // ── Daily loss circuit breaker ────────────────────────────────────────────
    const dailyLoss    = Math.max(0, this.dayStartBalance - balance);
    const maxDailyLoss = this.config.maxDailyLossUsdc || 15;
    if (dailyLoss >= maxDailyLoss) {
      console.log(`[OracleLag] ⛔ CIRCUIT BREAKER: daily loss $${dailyLoss.toFixed(2)} ≥ limit $${maxDailyLoss} — pausing trading for today`);
      this.paused = true;
      this.emit('circuit_breaker', { reason: 'daily_loss', dailyLoss, maxDailyLoss, balance });
      tg.circuitBreakerAlert({ dailyLoss, maxDailyLoss, balance });
      return;
    }

    // ── Drawdown-based position scaling ──────────────────────────────────────
    const drawdownPct   = this.sessionPeak > 0 ? (this.sessionPeak - balance) / this.sessionPeak : 0;
    const drawdownScale = drawdownPct >= 0.35 ? 0.30   // severe drawdown  (>35%): bet 30% of normal
                        : drawdownPct >= 0.20 ? 0.60   // moderate drawdown(>20%): bet 60% of normal
                        : 1.0;
    if (drawdownScale < 1.0) {
      console.log(`[OracleLag] ⚠ Drawdown ${(drawdownPct*100).toFixed(1)}% (peak $${this.sessionPeak.toFixed(2)}→$${balance.toFixed(2)}) — sizing at ${(drawdownScale*100).toFixed(0)}%`);
    }

    // ── Kelly sizing ──────────────────────────────────────────────────────────
    // f* = (p*b - (1-p)) / b   where b = net odds = (1 - ask) / ask
    // Quarter Kelly (f* * 0.25) — conservative until sufficient live data per path.
    // Win rate p: rolling last 30 settled trades, filtered by path bucket.
    //   REVERSAL: ~60 live trades, use observed rate. Min floor: 0.70 (conservative prior).
    //   SPIKE:    0 live trades so far — use backtest rate 0.986 but cap bet at 5% of balance
    //             until 50 live SPIKE trades accumulate. Earns right to size up with data.
    //   LATE/WINDOW: use observed or fall back to backtest priors.
    const isLate  = path.includes('LATE');
    const isDoge  = symbol === 'DOGE';
    const isSpike = path.includes('SPIKE') && !path.includes('REVERSAL') && !path.includes('WINDOW');

    const kellyWinRate = this._kellyWinRate(path, symbol);
    const kellyB       = (1 - price) / price;           // net odds at entry price
    const kellyF       = (kellyWinRate * kellyB - (1 - kellyWinRate)) / kellyB;
    const kellyFull    = Math.max(0, kellyF);
    const kellyQuarter = kellyFull * 0.25;

    // Hard cap per-path until live data earns right to size up:
    //   SPIKE: 5% until 50 live trades, then lifts to 10%
    //     → when balance < $30, raise to 10% so Kelly * cap * available >= $2 min
    //   REVERSAL/WINDOW: 10% (60+ live trades)
    //   LATE: 8% (lower confidence, higher CLOB)
    const liveSpikeTrades = this._liveTradeCount('SPIKE');
    const lowBalance = balance < 45;  // raise SPIKE cap to 10% until balance recovers to $45
    const pathCap = isSpike  ? (liveSpikeTrades >= 50 ? 0.10 : (lowBalance ? 0.10 : 0.05))
                  : isLate   ? (lowBalance ? 0.10 : 0.08)
                  : 0.10;

    const fraction = Math.min(kellyQuarter, pathCap);
    console.log(`[OracleLag] Kelly: p=${kellyWinRate.toFixed(3)} b=${kellyB.toFixed(3)} f*=${kellyFull.toFixed(3)} →¼Kelly=${kellyQuarter.toFixed(3)} cap=${pathCap} →fraction=${fraction.toFixed(3)} (${path} live_spike=${liveSpikeTrades})`);

    // ── Consecutive loss guard — reduce sizing after 2 losses in a row ────────
    const lossGuard = this.consecutiveLosses >= 2 ? 0.65 : 1.0;
    if (lossGuard < 1.0) {
      console.log(`[OracleLag] ⚠ Consecutive losses: ${this.consecutiveLosses} — sizing at 65%`);
    }

    // ── Balance floor — stop trading if balance drops below $55 (protects 70% of $80 starting capital)
    if (balance < 55) {
      console.log(`[OracleLag] ⛔ Balance $${balance.toFixed(2)} below floor $55 — capital protection active`);
      return;
    }

    // Apply all scaling factors + absolute per-bet cap
    // Hard cap at $5/bet until live win rate is confirmed across 20+ trades.
    // High-CLOB entries (>0.70): profit margin per share is thin — keep at $5 hard cap.
    // At CLOB=0.82 a $5 bet wins only $1.10 — need many wins to offset one loss.
    const balanceCap = 5;
    const timeframeCap = (market._timeframe && market._timeframe !== '5m')
      ? (isDoge ? 15 : 10)
      : Infinity;
    const dailyPnl = balance - this.dayStartBalance;
    const size = Math.min(balanceCap, timeframeCap, available * fraction * drawdownScale * lossGuard);
    console.log(`[OracleLag] Sizing: bal=${balance.toFixed(2)} avail=${available.toFixed(2)} frac=${fraction.toFixed(3)} drawdown=${drawdownScale} loss=${lossGuard} balCap=${balanceCap} tfCap=${timeframeCap} → size=${size.toFixed(2)}`);
    // Min trade $2 (was $5) — Kelly at low balance (~$26) produces $1-2 bets; $5 floor
    // was silently blocking all signals. $2 is still meaningful (>7% of balance).
    if (size < 2) return;

    this.committedUsdc += size;
    this.activePositions++;
    try {
      // ── Book depth check — ensure enough liquidity at our fill price ─────
      // Late-conviction entries are at high CLOB prices (0.45-0.68): tighter offset
      // to avoid overpaying — AMM ASK is typically bid+0.01, so +0.03 is sufficient
      const isLateExec = path.includes('LATE');
      const bidOffset = reversalStalePrice != null ? 0.08 : isEarlyOnly ? 0.05 : isLateExec ? 0.03 : 0.07;
      const fillPrice = Math.min(parseFloat((price + bidOffset).toFixed(2)), 0.76);
      const sharesNeeded = Math.floor(size / price);
      const cachedAsks  = this.clobPrices[tokenId]?.asks || [];
      const depthShares = cachedAsks
        .filter(a => a.price <= fillPrice)
        .reduce((sum, a) => sum + a.size, 0);
      if (cachedAsks.length > 0 && depthShares < sharesNeeded * 0.3) {
        // Less than 30% of needed shares available at our price — book too thin
        console.log(`[OracleLag] Thin book: only ${depthShares.toFixed(0)} shares at ≤${fillPrice} (need ${sharesNeeded}) — skip`);
        this.committedUsdc = Math.max(0, this.committedUsdc - size);
        this.activePositions--;
        // Keep tradedMarkets set — book won't thicken instantly; prevents duplicate attempts
        return;
      }
      const submitTs = Date.now();
      const signalToSubmitMs = submitTs - signalTs;
      console.log(`[OracleLag] Executing GTC: BUY ${direction} $${size.toFixed(2)} @ ${fillPrice.toFixed(3)} (bid=${price.toFixed(3)}+${bidOffset}) depth=${depthShares.toFixed(0)}sh | signal→submit: ${signalToSubmitMs}ms`);

      const { OrderType } = require('@polymarket/clob-client');
      const order = await this.poly.placeBuyOrder(tokenId, fillPrice, size, 0.01, false, OrderType.GTC);
      const confirmTs = Date.now();
      const submitToConfirmMs = confirmTs - submitTs;
      const orderId = order?.orderID || order?.errorMsg || JSON.stringify(order)?.slice(0, 200);
      console.log(`[OracleLag] GTC order placed: ${orderId} status=${order?.status} takenUSDC=${order?.takingAmount} | submit→confirm: ${submitToConfirmMs}ms | total: ${confirmTs - signalTs}ms`);

      if (order?.error || !order?.orderID) {
        const errMsg = order?.error || 'no orderID';
        console.warn(`[OracleLag] GTC order rejected (${errMsg}) — skipping`);
        this.committedUsdc = Math.max(0, this.committedUsdc - size);
        this.activePositions--;
        // Keep tradedMarkets set — order was explicitly rejected; don't retry same market
        return;
      }

      // Track whether order was (partially) filled at placement time.
      // takingAmount = outcome tokens received. If > 0 at placement, order partially/fully filled.
      const immediatelyFilled = parseFloat(order.takingAmount || '0') > 0;

      // Auto-cancel: cancel the GTC order before market closes so funds aren't locked.
      // Cancel 10s before market end, or after 55s max — whichever is sooner.
      // REVERSAL + not immediately filled = AMM already repriced away from our cached price.
      // Edge is gone — cancel in 5s rather than burning a trade slot for 55s.
      const msLeft      = market._endsAtMs ? market._endsAtMs - Date.now() : 60000;
      const isReversal  = path.includes('REVERSAL');
      const cancelAfter = (!immediatelyFilled && isReversal)
        ? 5_000
        : Math.min(55000, Math.max(8000, msLeft - 10000));
      console.log(`[OracleLag] GTC auto-cancel in ${(cancelAfter / 1000).toFixed(0)}s | immediatelyFilled=${immediatelyFilled}`);

      const slug = market.slug || '';
      const marketUrl = slug ? `https://polymarket.com/event/${slug}` : '';

      // takingAmount = outcome tokens received (NOT USDC). usdcSpent = tokens * price.
      const tokensReceived = parseFloat(order.takingAmount || '0');
      const usdcSpent = tokensReceived > 0 ? tokensReceived * price : size;

      this._recordTrade();
      tg.tradeAlert({ symbol, direction, path, clobPrice: price, size, orderId: order.orderID, timeframe: market._timeframe || '5m' });
      // Register for settlement polling — will fire WIN/LOSS Telegram alert when resolved
      this._watchedPositions.push({
        conditionId: market.condition_id, orderId: order.orderID,
        direction, entryPrice: price, size: usdcSpent, tokensReceived,
        market: question, path, symbol, ts: Date.now(),
      });
      this.emit('trade_executed', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        slug, marketUrl,
        tokenId, side: direction, price, size, orderId: order.orderID, path, ts: Date.now(),
        latency: { signalToSubmitMs, submitToConfirmMs, totalMs: confirmTs - signalTs },
        refDivergence, refSuspect,
      });

      setTimeout(async () => {
        try {
          await this.poly.cancelOrder(order.orderID);
          // Cancel succeeded — but only treat as "unfilled" if no tokens were received at placement.
          // If partially filled at placement (immediatelyFilled=true), tokens are in wallet — keep the log.
          if (!immediatelyFilled) {
            console.log(`[OracleLag] GTC order cancelled (unfilled): ${order.orderID}`);
            // Remove from watched — no position was ever opened, nothing to settle
            this._watchedPositions = this._watchedPositions.filter(p => p.orderId !== order.orderID);
            this.emit('trade_cancelled', { orderId: order.orderID, marketId: market.condition_id });
          } else {
            console.log(`[OracleLag] GTC order cancelled remainder (was partially filled): ${order.orderID}`);
          }
        } catch {
          // Cancel failed = order already fully filled — keep the bet log entry
          console.log(`[OracleLag] GTC order filled (cancel rejected): ${order.orderID}`);
        }
        this.activePositions--;
        this.committedUsdc = Math.max(0, this.committedUsdc - size);
      }, cancelAfter);

    } catch (err) {
      const msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
      console.error('[OracleLag] Trade failed:', msg.slice(0, 120));
      this.committedUsdc = Math.max(0, this.committedUsdc - size);
      this.activePositions--;
      // Keep tradedMarkets set — prevents duplicate bets on same market if error was transient
    }
  }

  async _pollSettledPositions() {
    if (!this._watchedPositions.length) return;
    // Drop positions older than 2 hours (should have settled by then)
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    this._watchedPositions = this._watchedPositions.filter(p => p.ts > cutoff);
    if (!this._watchedPositions.length) return;

    try {
      const wallet = this.poly?.wallet?.address;
      if (!wallet) return;
      const res = await axios.get(
        `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=.001&sortBy=CURRENT`,
        { timeout: 8000 }
      );
      const apiPositions = res.data || [];
      const byCondition = {};
      for (const p of apiPositions) if (p.conditionId) byCondition[p.conditionId] = p;

      const remaining = [];
      for (const watched of this._watchedPositions) {
        const pos = byCondition[watched.conditionId];
        if (!pos) {
          // Not in API yet — keep watching (API has ~30s lag)
          remaining.push(watched);
          continue;
        }
        const cur        = parseFloat(pos.curPrice ?? 0);
        const redeemable = pos.redeemable === true;

        if (redeemable && cur >= 0.99) {
          // WIN: each token redeems for $1 USDC. profit = tokens*(1-price), gross = tokens*1.
          const tokens = watched.tokensReceived || (watched.size / watched.entryPrice);
          const pnl = tokens * (1 - watched.entryPrice);
          console.log(`[OracleLag] Position settled WIN: ${watched.symbol} ${watched.direction} +$${pnl.toFixed(2)} (${tokens.toFixed(2)} tokens @ ${watched.entryPrice})`);
          tg.positionSettledAlert({ symbol: watched.symbol, direction: watched.direction, path: watched.path, entryPrice: watched.entryPrice, size: watched.size, result: 'WIN', pnl, market: watched.market });
          this._recordSettlement('WIN', pnl, watched);
          this.dayWinCount++;
          this.consecutiveLosses = 0; // reset streak on win
          // Don't keep in remaining — done
        } else if (redeemable && cur < 0.05) {
          // LOSS: lose what was spent
          const pnl = -watched.size;
          console.log(`[OracleLag] Position settled LOSS: ${watched.symbol} ${watched.direction} -$${watched.size.toFixed(2)}`);
          tg.positionSettledAlert({ symbol: watched.symbol, direction: watched.direction, path: watched.path, entryPrice: watched.entryPrice, size: watched.size, result: 'LOSS', pnl, market: watched.market });
          this._recordSettlement('LOSS', pnl, watched);
          this.dayLossCount++;
          this.consecutiveLosses++;
        } else {
          // Still open — keep watching
          remaining.push(watched);
        }
      }
      this._watchedPositions = remaining;
    } catch { /* ignore — retry next interval */ }
  }

  /** Write WIN/LOSS result back into bet_log.json for the matching trade */
  _recordSettlement(result, pnl, watched) {
    const fs   = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, '..', '..', 'bet_log.json');
    try {
      const bets = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      // Match by conditionId (marketId) or by symbol+ts proximity (within 10min)
      let matched = false;
      for (const bet of bets) {
        const sameMarket = bet.marketId === watched.conditionId;
        const closeInTime = Math.abs((bet.ts || 0) - watched.ts) < 600000;
        const sameSym = (bet.market || '').toLowerCase().includes(watched.symbol.toLowerCase());
        if ((sameMarket || (closeInTime && sameSym)) && !bet.result) {
          bet.result = result;
          bet.pnl    = parseFloat(pnl.toFixed(4));
          matched = true;
          break;
        }
      }
      if (matched) {
        fs.writeFileSync(logPath, JSON.stringify(bets, null, 2));
        console.log(`[OracleLag] bet_log updated: ${watched.symbol} ${result} pnl=$${pnl.toFixed(2)}`);
      }
    } catch (err) {
      console.warn('[OracleLag] bet_log update failed:', err.message);
    }
  }

  _canTrade() {
    const now = Date.now();
    this.tradeTimestamps = this.tradeTimestamps.filter(t => now - t < 3600000);
    return this.tradeTimestamps.length < this.maxTradesPerHour;
  }

  _recordTrade() {
    this.tradeTimestamps.push(Date.now());
    this.dayTradeCount++;
    console.log(`[OracleLag] Daily trade count: ${this.dayTradeCount}/${this.config.maxDailyTrades || 3}`);
  }

  /**
   * Rolling win rate for Kelly sizing — last 30 settled trades, filtered by path bucket.
   * Path buckets: 'REVERSAL', 'SPIKE', 'WINDOW', 'LATE', 'OTHER'
   * Falls back to backtest priors when live sample is small (< 10 trades in bucket).
   */
  _kellyWinRate(path, symbol) {
    // Priors updated Apr 22 2026: REVERSAL threshold lowered (0.75→0.70 stale) — prior kept
    // conservative at 0.72 until live data builds. LATE prior reflects higher CLOB entries
    // now allowed (up to 0.82) — lower prior 0.85→0.83 to account for reduced margin trades.
    const PRIORS = { REVERSAL: 0.72, SPIKE: 0.986, WINDOW: 0.997, LATE: 0.83, OTHER: 0.70 };
    const bucket = path.includes('REVERSAL') ? 'REVERSAL'
                 : path.includes('SPIKE')    ? 'SPIKE'
                 : path.includes('WINDOW')   ? 'WINDOW'
                 : path.includes('LATE')     ? 'LATE'
                 : 'OTHER';
    try {
      const fs = require('fs'), p = require('path');
      const raw = fs.readFileSync(p.join(__dirname, '..', 'bet_log.json'), 'utf8');
      const trades = JSON.parse(raw);
      const settled = trades
        .filter(t => (t.result === 'WIN' || t.result === 'LOSS') && t.path)
        .filter(t => {
          const b = t.path.includes('REVERSAL') ? 'REVERSAL'
                  : t.path.includes('SPIKE')    ? 'SPIKE'
                  : t.path.includes('WINDOW')   ? 'WINDOW'
                  : t.path.includes('LATE')     ? 'LATE'
                  : 'OTHER';
          return b === bucket;
        })
        .slice(-30);
      if (settled.length < 10) return PRIORS[bucket]; // not enough data — use prior
      const wins = settled.filter(t => t.result === 'WIN').length;
      // Blend observed rate with prior, weighted by sample size (full weight at 30+)
      const weight = Math.min(settled.length, 30) / 30;
      const observed = wins / settled.length;
      return weight * observed + (1 - weight) * PRIORS[bucket];
    } catch {
      return PRIORS[bucket];
    }
  }

  /** Count live settled trades for a given path bucket (for SPIKE cap logic). */
  _liveTradeCount(bucket) {
    try {
      const fs = require('fs'), p = require('path');
      const trades = JSON.parse(fs.readFileSync(p.join(__dirname, '..', 'bet_log.json'), 'utf8'));
      return trades.filter(t =>
        (t.result === 'WIN' || t.result === 'LOSS') &&
        t.path && t.path.includes(bucket) &&
        !t.path.includes('REVERSAL') && !t.path.includes('WINDOW')
      ).length;
    } catch { return 0; }
  }

  /**
   * Append a signal event to signal_log.jsonl for forward calibration.
   * JSONL format: one JSON object per line, appended synchronously.
   * O(1) write regardless of log size — never reads the file.
   *
   * Schema per line:
   *   ts, date, type, symbol, timeframe, path, enabled, direction,
   *   pctWindow, spike60, clobPrice, maxClobPrice, msLeft,
   *   blocked_by, traded, tokenId
   *
   * 30s CLOB snapshots land in signal_snapshots.jsonl as separate lines:
   *   { ts, tokenId, clob_ask_30s, date_30s }
   * Join on ts during analysis: SELECT s.*, n.clob_ask_30s
   *   FROM read_ndjson_auto('signal_log.jsonl') s
   *   LEFT JOIN read_ndjson_auto('signal_snapshots.jsonl') n USING (ts)
   */
  _logSignalEvent(event) {
    const fs   = require('fs');
    const path = require('path');
    const ts   = Date.now();
    const entry = { ts, date: new Date(ts).toISOString(), ...event };
    try {
      fs.appendFileSync(
        path.join(__dirname, '..', 'signal_log.jsonl'),
        JSON.stringify(entry) + '\n'
      );
    } catch { /* ignore write errors */ }

    // 30s CLOB snapshot — written to a separate JSONL file so the main log
    // stays append-only. During DuckDB analysis, LEFT JOIN on ts.
    // This is the most direct test of oracle lag thesis: did the CLOB move
    // in the predicted direction within 30s of the signal?
    if (event.tokenId) {
      setTimeout(async () => {
        try {
          const ask30s = await this._getClobPrice(event.tokenId);
          if (ask30s == null) return;
          const snap = { ts, tokenId: event.tokenId, clob_ask_30s: ask30s, date_30s: new Date().toISOString() };
          fs.appendFileSync(
            path.join(__dirname, '..', 'signal_snapshots.jsonl'),
            JSON.stringify(snap) + '\n'
          );
        } catch { /* ignore */ }
      }, 30_000);
    }
  }

  stop() {
    this.running = false;
    if (this.ws) this.ws.close();
    if (this.clobWs) this.clobWs.close();
  }
}

module.exports = { OracleLagArb };
