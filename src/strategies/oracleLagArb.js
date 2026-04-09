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
 *    PATH A (spike-led):  spike60 ≥ 0.20% + window ≥ 0.20% + no prior bounce → CLOB < 0.42
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
    this.priceHistory = {};            // symbol → [{price, ts}] rolling 120s buffer
    this.lastEvalTs    = {};           // symbol → ts of last evaluation (move-triggered throttle)
    this.lastEvalPrice = {};           // symbol → price at last evaluation
    this.fokCooldown   = {};           // conditionId → ts of last FOK failure (30s retry block)

    // ── Risk tracking ──────────────────────────────────────────────────────────
    this.sessionPeak      = 0;         // highest balance seen this session (for drawdown calc)
    this.dayString        = '';        // YYYY-MM-DD of current trading day
    this.dayStartBalance  = 0;         // balance at start of current calendar day
    this.dayTradeCount    = 0;         // trades placed today (resets at UTC midnight)
    this.dayTradeString   = '';        // date of last dayTradeCount reset

    // ── WS health watchdog ─────────────────────────────────────────────────────
    this.lastBinanceTick  = 0;         // ms timestamp of last Binance aggTrade message

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
      console.log('[OracleLag] Window reset — new reference prices set for all symbols');
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

  /** Watchdog: if no Binance tick in >30s, force-reconnect the WS */
  _startBinanceWatchdog() {
    this.lastBinanceTick = Date.now(); // seed so we don't fire immediately on start
    setInterval(() => {
      if (!this.running) return;
      const silentMs = Date.now() - this.lastBinanceTick;
      if (silentMs > 30_000) {
        console.warn(`[OracleLag] Binance WS silent for ${Math.round(silentMs / 1000)}s — forcing reconnect`);
        try { this.ws?.terminate(); } catch { /* ignore */ }
        this._connectBinance();
      }
    }, 15_000); // check every 15s
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
      { name: '4h',  intervalSec: 14400, lookAhead: 0 },
    ];

    const fetches = [];
    for (const asset of Object.keys(ASSET_SYMBOL_MAP)) {
      for (const tf of TIMEFRAMES) {
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
      } catch { /* skip */ }
    }));

    // Subscribe new tokens to CLOB WebSocket
    if (newTokenIds.length > 0) this._subscribeClobTokens(newTokenIds);

    const by5m  = [...this.markets.values()].filter(m => m._timeframe === '5m').length;
    const by15m = [...this.markets.values()].filter(m => m._timeframe === '15m').length;
    const by4h  = [...this.markets.values()].filter(m => m._timeframe === '4h').length;
    console.log(`[OracleLag] Tracking ${this.markets.size} markets (${by5m} 5m, ${by15m} 15m, ${by4h} 4h) | ${found} new`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Signal detection
  // ─────────────────────────────────────────────────────────────────────────────

  async _checkOpportunity(symbol, currentPrice) {
    if (!this.running || this.paused || !this._canTrade()) return;

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

      // For 15m and 4h markets: oracle lag only applies in the final 8 minutes.
      // Before that, there's too much time left for the edge to survive.
      const timeframe = market._timeframe || '5m';
      if (timeframe !== '5m' && market._endsAtMs) {
        const msToExpiry = market._endsAtMs - now;
        if (msToExpiry > 8 * 60 * 1000) return; // too early — check back later
      }

      const upToken   = market._upToken;
      const downToken = market._downToken;

      // ── Window move (from 5-min boundary open) ────────────────────────────
      const windowOpen = this.windowOpenPrices.get(symbol) || spotPrice;
      const pctWindow  = ((spotPrice - windowOpen) / windowOpen) * 100;

      // ── Spike detection (synchronous, zero latency) ────────────────────────
      const histAge = this._historyAge(symbol);
      const spike60 = histAge >= 25 ? this._getRecentMove(symbol, 60) : 0;
      const spike30 = histAge >= 15 ? this._getRecentMove(symbol, 30) : 0;
      const spike15 = histAge >=  5 ? this._getRecentMove(symbol, 15) : 0;
      const spike10 = histAge >=  3 ? this._getRecentMove(symbol, 10) : 0;

      // ── Anti-bounce: prior-context check for SPIKE/WINDOW paths ───────────
      // "priorContext" = net move from 8-min-ago to 2-min-ago.
      // Extended from 5m → 8m lookback: prior drops that fell just outside the old
      // 5-min window were still causing bounces (BTC Apr 8 case: blocked for many ticks
      // at priorCtx=-0.28%, then priorCtx faded above -0.12% as drop exited window → trade
      // fired and lost — the bounce context was real, just too old for the 5m window).
      // 8m lookback keeps the prior drop visible for 6 more minutes.
      //
      // "netTrend8m" = raw 8-min net move (independent of move2m).
      // Guards against cases where the prior drop is so old it fell out even of the 8m window
      // but the overall 8-min trend is still net-negative — i.e. we're in a sustained dump.
      const move8m = histAge >= 420 ? this._getRecentMove(symbol, 480) : null;
      const move2m = histAge >=  90 ? this._getRecentMove(symbol, 120) : null;
      const priorContext = (move8m !== null && move2m !== null) ? move8m - move2m : null;
      // Additional guard: if the full 8-min net trend opposes the spike direction by >0.15%,
      // we're still in a broader counter-trend move — block even if priorCtx passes.
      const netTrend8m = move8m;
      const trendOpposesSpike = netTrend8m !== null && (
        spike60 > 0 ? netTrend8m < -0.15   // UP spike but 8m net still DOWN >0.15%
                    : netTrend8m >  0.15   // DOWN spike but 8m net still UP >0.15%
      );
      // Loosened from -0.12 → -0.25: backtest showed filter blocked 172 wins to save 4 losses.
      // Net P&L impact was -$6,695. Keep the filter to catch clear bounces but don't over-restrict.
      const antiBouncePasses = priorContext === null
        ? !trendOpposesSpike
        : (spike60 > 0 ? priorContext >= -0.25 : priorContext <= 0.25) && !trendOpposesSpike;

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
        // Raised stale threshold to 0.70 (was 0.55) — reduces false reversals.
        // Raised disagreement to 0.20% (was 0.12%) — only act on clear divergence.
        if (upClobAsk > 0.70 && pctWindow < -0.20) {
          isReversal = true;
          reversalDirection = 'DOWN';
          reversalStaleSidePrice = upClobAsk;
        } else if (downClobAsk > 0.70 && pctWindow > 0.20) {
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
      const wouldBeSpike = Math.abs(spike60) >= 0.20 && Math.abs(pctWindow) >= 0.20 && spikeDir60 && windowAgeMs >= 90000 && antiBouncePasses;
      const isSpikeLed   = false; // disabled — logging only
      // PATH B thresholds vary by timeframe:
      // 5m/15m: window ≥ 0.70% + spike60 ≥ 0.20% — calibrated from backtest
      // 4h: window ≥ 1.00% + spike60 ≥ 0.35% — 4h markets need a stronger recent move
      //     because pctWindow accumulates over hours (0.70% is noise in a 4h window).
      //     spike60 is the real signal — it must be strong enough to lag the oracle.
      const windowThresh = timeframe === '4h' ? 1.00 : 0.70;
      const spike60Thresh = timeframe === '4h' ? 0.35 : 0.20;
      const isWindowLed = Math.abs(pctWindow) >= windowThresh && Math.abs(spike60) >= spike60Thresh && spikeDir60 && windowAgeMs >= 90000 && antiBouncePasses;
      if (!antiBouncePasses && (Math.abs(spike60) >= 0.20 || Math.abs(pctWindow) >= 0.55)) {
        const bcReason = trendOpposesSpike ? `trend8m=${netTrend8m>=0?'+':''}${netTrend8m.toFixed(3)}%` : `priorCtx=${priorContext>=0?'+':''}${priorContext.toFixed(3)}%`;
        console.log(`[OracleLag] [BOUNCE-BLOCK] ${symbol} spike60=${spike60>=0?'+':''}${spike60.toFixed(3)}% ${bcReason} — recovery bounce, skipping SPIKE/WINDOW`);
        // Log would-be SPIKE signals so bounce data accumulates in signal_log
        const bounceDir = spike60 > 0 ? 'UP' : 'DOWN';
        const bounceToken = bounceDir === 'UP' ? upToken : downToken;
        this._logSignalEvent({ type: 'BOUNCE_BLOCK', symbol, timeframe, direction: bounceDir, pctWindow, spike60, priorContext, netTrend8m, blocked_by: 'BOUNCE_BLOCK', traded: false, tokenId: bounceToken.token_id });
      }
      // Log disabled SPIKE signals that would have fired (not bounce-blocked, just disabled)
      if (wouldBeSpike && !(!antiBouncePasses)) {
        const spikeDir = pctWindow > 0 ? 'UP' : 'DOWN';
        const spikeToken = spikeDir === 'UP' ? upToken : downToken;
        const spikeClobRaw = spikeDir === 'UP' ? upClobAsk : downClobAsk;
        if (spikeClobRaw != null) {
          this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path: 'SPIKE', enabled: false, direction: spikeDir, pctWindow, spike60, clobPrice: spikeClobRaw, maxClobPrice: 0.38, msLeft: market._endsAtMs - now, blocked_by: 'DISABLED', traded: false, tokenId: spikeToken.token_id });
        }
      }
      // PATH D (EARLY): disabled — 0W/3L track record (-$24), all losses.
      // Early spikes fire before the window has enough price history to confirm direction.
      // SPIKE and WINDOW paths (which require ≥90s window age) have much better fill quality.
      const spikeDir15  = false;
      const spikeDir10  = false;
      const earlyAgree  = false;
      const isEarlySpike = false;

      // ── Multi-asset correlation filter ────────────────────────────────────────
      // If ≥4 assets are all moving the same direction (>0.15% window move), it's a
      // broad market pump/dump — market makers reprice everything simultaneously and the
      // oracle lag edge shrinks. Skip to avoid chasing efficient moves.
      const assetDir = pctWindow > 0 ? 1 : -1;
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
      const anySignal       = isReversal || isSpikeLed || isWindowLed || isEarlySpike;
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

      if (!isReversal && !isSpikeLed && !isWindowLed && !isEarlySpike) return;

      // ── Determine final direction & target token ───────────────────────────
      const targetDirection = isReversal ? reversalDirection : btcDirection;
      const targetToken     = targetDirection === 'UP' ? upToken : downToken;

      // Build path label
      const pathParts = [];
      if (isReversal)   pathParts.push('REVERSAL');
      if (isEarlySpike && btcDirection === targetDirection) pathParts.push('EARLY');
      if (isSpikeLed   && btcDirection === targetDirection) pathParts.push('SPIKE');
      if (isWindowLed  && btcDirection === targetDirection) pathParts.push('WINDOW');
      const path = pathParts.join('+') || 'REVERSAL';

      // ── CLOB price for target token (0ms from cache) ──────────────────────
      const clobPrice = await this._getClobPrice(targetToken.token_id);
      if (!clobPrice) { console.log(`[OracleLag] CLOB price unavailable for ${symbol} ${targetDirection}`); return; }

      const clobCacheTs  = this.clobPrices[targetToken.token_id]?.ts;
      const clobAgeMs    = clobCacheTs ? Date.now() - clobCacheTs : Infinity;
      const wsAge        = clobCacheTs ? `${(clobAgeMs / 1000).toFixed(1)}s ago` : 'HTTP';

      // ── Max CLOB thresholds — data-driven from 13 resolved bets ────────────
      // Observed win rates: <0.30=33%, 0.30-0.38=75%, 0.38-0.44=0%, >0.44=25%
      // Hard cap at 0.38 — every bet above 0.38 has been net negative.
      // REVERSAL gets slightly higher cap because target token is cheap side.
      const maxClobPrice = isReversal
        ? (reversalStaleSidePrice > 0.85 ? 0.38 : reversalStaleSidePrice > 0.75 ? 0.32 : 0.26)
        : 0.38;  // unified cap across EARLY/SPIKE/WINDOW — data shows 0%+ above this

      // CLOB floor: 0W/4L below 0.20, 1W/2L at 0.20-0.25 — both buckets negative EV.
      // Data from 31 trades: sweet spot is 0.28-0.38. Raise floor to 0.28.
      if (clobPrice < 0.28) {
        console.log(`[OracleLag] CLOB ${targetDirection}=${clobPrice.toFixed(3)} < 0.28 floor — skip`);
        this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft: market._endsAtMs - Date.now(), blocked_by: 'CLOB_FLOOR', traded: false, tokenId: targetToken.token_id });
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
      const tooLate  = msLeft < 45000;
      const clobOver = clobPrice >= maxClobPrice;
      const scanStatus = (clobOver || tooLate) ? 'skip' : 'ready';

      const marketSlug = market.slug || '';
      const marketUrl  = marketSlug ? `https://polymarket.com/event/${marketSlug}` : '';
      this.emit('scan_tick', { symbol, path, pctWindow, spike60, spike15, spike10, clobPrice, maxClobPrice, direction: targetDirection, status: scanStatus, msLeft, marketUrl, marketSlug, timeframe });

      if (clobOver) {
        console.log(`[OracleLag] CLOB at ${clobPrice.toFixed(3)} ≥ max ${maxClobPrice} — skip`);
        this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft, blocked_by: 'CLOB_OVER', traded: false, tokenId: targetToken.token_id });
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

      console.log(`[OracleLag] *** OPPORTUNITY [${finalPath}]: ${question}`);
      console.log(`            BUY ${targetDirection} @ ${clobPrice.toFixed(3)} (max=${maxClobPrice}) | ${(msLeft/1000).toFixed(0)}s left`);

      this.emit('opportunity', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        symbol, spotPrice, windowOpen, pctMove: pctWindow, spike60, spike30, spike15, spike10, path: finalPath,
        direction: targetDirection, tokenId: targetToken.token_id, side: targetDirection,
        price: clobPrice, expectedEdge: (maxClobPrice - clobPrice).toFixed(3), msLeft,
      });

      const signalTs = Date.now(); // ← latency measurement starts here
      this._logSignalEvent({ type: 'SIGNAL', symbol, timeframe, path: finalPath, enabled: true, direction: targetDirection, pctWindow, spike60, clobPrice, maxClobPrice, msLeft, blocked_by: null, traded: true, tokenId: targetToken.token_id });
      this.tradedMarkets.add(market.condition_id);
      await this._executeTrade(market, targetToken.token_id, clobPrice, targetDirection, question, pctWindow, isReversal ? reversalStaleSidePrice : null, isEarlyOnly, finalPath, signalTs);

    } catch (err) {
      console.warn('[OracleLag] Evaluate error:', err.message);
    } finally {
      this.evaluatingMarkets.delete(cid);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trade execution
  // ─────────────────────────────────────────────────────────────────────────────

  async _executeTrade(market, tokenId, price, direction, question, pctWindow = 0.5, reversalStalePrice = null, isEarlyOnly = false, path = '', signalTs = Date.now()) {
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
      this.tradedMarkets.delete(market.condition_id);
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
      this.dayString       = todayStr;
      this.dayStartBalance = balance;
      this.dayTradeCount   = 0;
      this.dayTradeString  = todayStr;
      this._persistDayState();
      console.log(`[OracleLag] New day (${todayStr}) — counters reset. Start balance: $${balance.toFixed(2)}`);
    }
    if (!this.dayStartBalance) { this.dayStartBalance = balance; this._persistDayState(); }

    // ── Daily trade cap ───────────────────────────────────────────────────────
    const maxDailyTrades = this.config.maxDailyTrades || 3;
    if (this.dayTradeCount >= maxDailyTrades) {
      console.log(`[OracleLag] ⛔ DAILY CAP: ${this.dayTradeCount}/${maxDailyTrades} trades today — pausing until midnight`);
      this.tradedMarkets.delete(market.condition_id);
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
      this.tradedMarkets.delete(market.condition_id);
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

    // ── CLOB-price-scaled sizing (data-driven from 28 trades) ─────────────────
    // 0.30-0.38 zone: 67% win rate → bet 25% (sweet spot, most confident)
    // 0.20-0.30 zone: 40% win rate, high payout → bet 15% (EV+, lower certainty)
    // 0.15-0.20 zone: unknown, new floor → bet 12% (cautious)
    // <0.15 zone:     blocked by floor check above
    // Reversal: sized by how wrong the CLOB is (stale side strength)
    const fraction = reversalStalePrice != null
      ? (reversalStalePrice > 0.80 ? 0.25 : reversalStalePrice > 0.75 ? 0.18 : 0.12)
      : price < 0.30 ? 0.15   // 0.25-0.30 zone — cautious, limited data
      : price < 0.38 ? 0.25   // sweet spot (0.30-0.38) — 60% win rate, confident size
      : 0.12;                  // above cap, shouldn't reach here

    // Apply drawdown scale + absolute per-bet cap when balance is low
    const balanceCap = balance < 30 ? 8 : balance < 40 ? 12 : this.config.maxPositionUsdc;
    // 15m/4h markets get a tighter size cap: wider window = more time for adverse moves.
    // Data: $27 loss on ETH 15m SPIKE was the single largest loss. Cap at $10 until win rate proven.
    const timeframeCap = (market._timeframe && market._timeframe !== '5m') ? 10 : Infinity;
    const size = Math.min(balanceCap, timeframeCap, available * fraction * drawdownScale);
    if (size < 5) return;

    this.committedUsdc += size;
    this.activePositions++;
    try {
      // ── Book depth check — ensure enough liquidity at our fill price ─────
      const bidOffset = reversalStalePrice != null ? 0.08 : isEarlyOnly ? 0.05 : 0.07;
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
        this.tradedMarkets.delete(market.condition_id);
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
        this.tradedMarkets.delete(market.condition_id);
        return;
      }

      // Track whether order was (partially) filled at placement time.
      // takingAmount = USDC taken from our wallet. If > 0 at placement, tokens were received.
      const immediatelyFilled = parseFloat(order.takingAmount || '0') > 0;

      // Auto-cancel: cancel the GTC order before market closes so funds aren't locked.
      // Cancel 10s before market end, or after 55s max — whichever is sooner.
      const msLeft      = market._endsAtMs ? market._endsAtMs - Date.now() : 60000;
      const cancelAfter = Math.min(55000, Math.max(8000, msLeft - 10000));
      console.log(`[OracleLag] GTC auto-cancel in ${(cancelAfter / 1000).toFixed(0)}s | immediatelyFilled=${immediatelyFilled}`);

      const slug = market.slug || '';
      const marketUrl = slug ? `https://polymarket.com/event/${slug}` : '';

      this._recordTrade();
      tg.tradeAlert({ symbol, direction, path, clobPrice: price, size, orderId: order.orderID, timeframe: market._timeframe || '5m' });
      this.emit('trade_executed', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        slug, marketUrl,
        tokenId, side: direction, price, size, orderId: order.orderID, path, ts: Date.now(),
        latency: { signalToSubmitMs, submitToConfirmMs, totalMs: confirmTs - signalTs },
      });

      setTimeout(async () => {
        try {
          await this.poly.cancelOrder(order.orderID);
          // Cancel succeeded — but only treat as "unfilled" if no tokens were received at placement.
          // If partially filled at placement (immediatelyFilled=true), tokens are in wallet — keep the log.
          if (!immediatelyFilled) {
            console.log(`[OracleLag] GTC order cancelled (unfilled): ${order.orderID}`);
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
      if (!msg.includes('balance') && !msg.includes('allowance')) {
        this.tradedMarkets.delete(market.condition_id);
      }
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
