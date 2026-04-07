'use strict';

/**
 * Oracle Latency Arbitrage — THE #1 documented Polymarket edge
 *
 * Targets "Bitcoin/Ethereum/Solana/XRP/DOGE/BNB Up or Down" 5-minute markets.
 * Markets are discovered via Gamma API using the slug pattern:
 *   {asset}-updown-5m-{unix_timestamp_of_window_start}
 * where the timestamp is always a multiple of 300 (5 minutes).
 *
 * Strategy:
 *  - Binance spot price moves BEFORE Polymarket order book reprices (~55s lag)
 *  - Detect SUDDEN moves via aggTrade stream (sub-second) + rolling price history
 *  - CLOB prices tracked via Polymarket WebSocket (zero HTTP latency)
 *  - Signal paths:
 *    PATH A (spike-led):  spike60 ≥ 0.20% + window ≥ 0.12% → CLOB < 0.42
 *    PATH B (window-led): window ≥ 0.55% + spike60 ≥ 0.12% → CLOB < 0.44
 *    PATH C (reversal):   CLOB stale >0.70 vs spot direction → buy cheap side, CLOB < 0.30-0.42
 *    PATH D (early):      spike15 ≥ 0.10% OR spike10 ≥ 0.08% → CLOB < 0.40, WS age < 1.5s
 *
 * Fee note: these markets use crypto_fees_v2 with 7.2% taker rate.
 */

const WebSocket = require('ws');
const axios = require('axios');
const EventEmitter = require('events');
const { checkSentiment, shouldTrade } = require('../newsSentiment');

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Slug asset prefix → Binance symbol
const ASSET_SYMBOL_MAP = {
  btc:  'BTC',
  eth:  'ETH',
  sol:  'SOL',
  xrp:  'XRP',
  doge: 'DOGE',
  bnb:  'BNB',
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

    // ── WS health watchdog ─────────────────────────────────────────────────────
    this.lastBinanceTick  = 0;         // ms timestamp of last Binance aggTrade message
  }

  /** Start oracle lag monitor */
  async start() {
    this.running = true;
    await this._refreshCryptoMarkets();
    this._connectBinance();
    this._connectClobWs();
    setInterval(() => this._refreshCryptoMarkets(), 15 * 1000); // ↑ from 30s
    this._scheduleWindowReset();
    this._startBinanceWatchdog();
    console.log('[OracleLag] Started — watching BTC/ETH/SOL/XRP/DOGE/BNB Up or Down markets');
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
          // Real-time price_changes — has best_bid and best_ask directly
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
    // Trust WS cache only if fresh AND not a suspiciously extreme value from a stale snapshot.
    // ask ≥ 0.95 with no recent price_change event often means the WS book snapshot had
    // a bad high limit order as asks[0] — verify via HTTP instead.
    if (cached && cached.ask != null && cached.ask < 0.95 && (Date.now() - cached.ts) < 15_000) {
      return cached.ask;
    }
    // Fallback: HTTP (only if WS data is stale/missing)
    try {
      const res = await axios.get('https://clob.polymarket.com/price', {
        params: { token_id: tokenId, side: 'buy' },
        timeout: 2000,
      });
      const p = parseFloat(res.data?.price);
      if (!isNaN(p)) {
        if (!this.clobPrices[tokenId]) this.clobPrices[tokenId] = {};
        this.clobPrices[tokenId].ask = p;
        this.clobPrices[tokenId].ts = Date.now();
      }
      return isNaN(p) ? null : p;
    } catch { return null; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Binance WebSocket — real-time spot prices
  // ─────────────────────────────────────────────────────────────────────────────

  _connectBinance() {
    const pairs = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'dogeusdt', 'bnbusdt'];
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
    const cutoff = now - 120_000;
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

    const windowStart = Math.floor(nowSec / 300) * 300;
    // Only look at current + next 2 future windows — never the past window
    const windows = [windowStart, windowStart + 300, windowStart + 600];

    const fetches = [];
    for (const asset of Object.keys(ASSET_SYMBOL_MAP)) {
      for (const ts of windows) {
        fetches.push({ slug: `${asset}-updown-5m-${ts}`, asset });
      }
    }

    const newTokenIds = [];

    await Promise.all(fetches.map(async ({ slug, asset }) => {
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

    console.log(`[OracleLag] Tracking ${this.markets.size} active Up/Down markets (${found} new)`);
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
    try {
      const now = Date.now();
      if (market._startsAtMs && market._startsAtMs > now) return;

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
      // PATH A: spike60 ≥ 0.20% + window ≥ 0.12% + ≥90s into window
      const isSpikeLed  = Math.abs(spike60) >= 0.20 && Math.abs(pctWindow) >= 0.12 && spikeDir60 && windowAgeMs >= 90000;
      // PATH B: window ≥ 0.55% + spike60 ≥ 0.12% + ≥90s into window
      const isWindowLed = Math.abs(pctWindow) >= 0.55 && Math.abs(spike60) >= 0.12 && spikeDir60 && windowAgeMs >= 90000;
      // PATH D: early spike — first seconds of a sharp move, CLOB still stale.
      // Requires BOTH spike15 AND spike10 to agree in direction (reduces false positives).
      // Thresholds raised: spike15 ≥ 0.12%, spike10 ≥ 0.08% (was OR-based with lower bar).
      const spikeDir15 = (pctWindow >= 0 && spike15 > 0) || (pctWindow <= 0 && spike15 < 0);
      const spikeDir10 = (pctWindow >= 0 && spike10 > 0) || (pctWindow <= 0 && spike10 < 0);
      const earlyAgree = spikeDir15 && spikeDir10 && Math.sign(spike15) === Math.sign(spike10);
      const isEarlySpike = symbol !== 'SOL' && earlyAgree
        && Math.abs(spike15) >= 0.12 && Math.abs(spike10) >= 0.08
        && Math.abs(pctWindow) >= 0.07;  // raised from 0.04% — filters micro-spikes

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

      // CLOB floor: don't bet on any token priced below 0.15.
      // Data shows 0% win rate on fills below 20¢ (CLOB ~0.08-0.15). The theoretical payout
      // is high but the oracle lag edge vanishes at such extreme prices — MMs know these move
      // mostly on news/fundamentals, not mean-reversion lag.
      if (clobPrice < 0.15) {
        console.log(`[OracleLag] CLOB ${targetDirection}=${clobPrice.toFixed(3)} < 0.15 floor (0% win rate zone) — skip`);
        return;
      }

      // PATH D requires very fresh CLOB (< 1.5s) — tightened from 2s.
      const isEarlyOnly = isEarlySpike && !isSpikeLed && !isWindowLed && !isReversal;
      if (isEarlyOnly && clobAgeMs > 1500) return;

      // ── Max CLOB thresholds — data-driven from 13 resolved bets ────────────
      // Observed win rates: <0.30=33%, 0.30-0.38=75%, 0.38-0.44=0%, >0.44=25%
      // Hard cap at 0.38 — every bet above 0.38 has been net negative.
      // REVERSAL gets slightly higher cap because target token is cheap side.
      const maxClobPrice = isReversal
        ? (reversalStaleSidePrice > 0.85 ? 0.38 : reversalStaleSidePrice > 0.75 ? 0.32 : 0.26)
        : 0.38;  // unified cap across EARLY/SPIKE/WINDOW — data shows 0%+ above this

      const earlyTag = isEarlyOnly ? ` 15s=${spike15>=0?'+':''}${spike15.toFixed(3)}% 10s=${spike10>=0?'+':''}${spike10.toFixed(3)}%` : '';
      console.log(`[OracleLag] [${path}] ${symbol} window=${pctWindow>=0?'+':''}${pctWindow.toFixed(3)}% 60s=${spike60>=0?'+':''}${spike60.toFixed(3)}%${earlyTag} | CLOB ${targetDirection}=${clobPrice.toFixed(3)} max=${maxClobPrice} age=${wsAge}${isReversal ? ` | stale=${reversalStaleSidePrice.toFixed(3)}` : ''}`);

      // Compute msLeft BEFORE emitting scan_tick so the dashboard status is accurate.
      // Previously msLeft was checked after scan_tick, causing dashboard to show 🔥 FIRE
      // even when the bot would immediately skip due to insufficient window time.
      const msLeft   = market._endsAtMs - now;
      const tooLate  = msLeft < 45000;
      const clobOver = clobPrice >= maxClobPrice;
      const scanStatus = (clobOver || tooLate) ? 'skip' : 'ready';

      const marketSlug = market.slug || '';
      const marketUrl  = marketSlug ? `https://polymarket.com/event/${marketSlug}` : '';
      this.emit('scan_tick', { symbol, path, pctWindow, spike60, spike15, spike10, clobPrice, maxClobPrice, direction: targetDirection, status: scanStatus, msLeft, marketUrl, marketSlug });

      if (clobOver) {
        console.log(`[OracleLag] CLOB at ${clobPrice.toFixed(3)} ≥ max ${maxClobPrice} — skip`);
        return;
      }

      if (tooLate) {
        console.log(`[OracleLag] ${symbol} ${targetDirection} — only ${(msLeft/1000).toFixed(0)}s left, skip`);
        return;
      }

      // ── CLOB velocity check — skip if book is already repricing fast ──────
      // If CLOB ask moved >0.04 in last 3s toward our direction, MMs are already on it.
      const clobEntry  = this.clobPrices[targetToken.token_id];
      const prevAsk    = clobEntry?.prevAsk;
      const prevAskAge = clobEntry ? (Date.now() - clobEntry.prevAskTs) : 9999;
      if (prevAsk != null && prevAskAge < 3000) {
        const clobDelta = Math.abs(clobPrice - prevAsk);
        if (clobDelta >= 0.04) {
          console.log(`[OracleLag] CLOB moving fast (${prevAsk.toFixed(3)}→${clobPrice.toFixed(3)} in ${(prevAskAge/1000).toFixed(1)}s) — repricing, skip`);
          return;
        }
      }

      const question = market.question?.slice(0, 65);

      // ── AI news sentiment check (SPIKE / WINDOW / REVERSAL only) ─────────────
      // EARLY path skips this — too latency-sensitive (every ms counts there).
      // For SPIKE/WINDOW/REVERSAL we have a ~15-45s window so we can afford 2-3s.
      let finalPath = path;
      if (!isEarlyOnly && this.config.anthropicApiKey && this.config.newsApiKey) {
        try {
          const sentiment = await checkSentiment(symbol, targetDirection, this.config.anthropicApiKey, this.config.newsApiKey);
          const pass = shouldTrade(targetDirection, sentiment);
          console.log(`[OracleLag] [AI] ${symbol} ${targetDirection} — verdict=${sentiment.verdict} conf=${sentiment.confidence.toFixed(2)} | ${sentiment.summary}`);
          this.emit('ai_verdict', { symbol, direction: targetDirection, verdict: sentiment.verdict, conf: sentiment.confidence, summary: sentiment.summary, pass });
          if (!pass) {
            console.log(`[OracleLag] [AI] Contra-signal (${sentiment.verdict} conf=${sentiment.confidence.toFixed(2)}) — SKIPPING trade`);
            this.tradedMarkets.delete(market.condition_id);
            return;
          }
          if (sentiment.verdict === targetDirection && sentiment.confidence >= 0.70) {
            finalPath = path + '+AI';
          }
        } catch (err) {
          console.warn('[OracleLag] [AI] Sentiment check failed, proceeding anyway:', err.message);
        }
      }

      console.log(`[OracleLag] *** OPPORTUNITY [${finalPath}]: ${question}`);
      console.log(`            BUY ${targetDirection} @ ${clobPrice.toFixed(3)} (max=${maxClobPrice}) | ${(msLeft/1000).toFixed(0)}s left`);

      this.emit('opportunity', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        symbol, spotPrice, windowOpen, pctMove: pctWindow, spike60, spike30, spike15, spike10, path: finalPath,
        direction: targetDirection, tokenId: targetToken.token_id, side: targetDirection,
        price: clobPrice, expectedEdge: (maxClobPrice - clobPrice).toFixed(3), msLeft,
      });

      this.tradedMarkets.add(market.condition_id);
      await this._executeTrade(market, targetToken.token_id, clobPrice, targetDirection, question, pctWindow, isReversal ? reversalStaleSidePrice : null, isEarlyOnly, finalPath);

    } catch (err) {
      console.warn('[OracleLag] Evaluate error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trade execution
  // ─────────────────────────────────────────────────────────────────────────────

  async _executeTrade(market, tokenId, price, direction, question, pctWindow = 0.5, reversalStalePrice = null, isEarlyOnly = false, path = '') {
    const balance   = await this.poly.getBalance().catch(() => 0);
    const reserve   = this.config.reserveUsdc || 5;
    const available = balance - reserve - this.committedUsdc;
    if (available < 5) {
      console.log(`[OracleLag] Balance too low ($${balance.toFixed(2)}) — skipping`);
      this.tradedMarkets.delete(market.condition_id);
      return;
    }

    // ── Session peak tracking (for drawdown scaling) ──────────────────────────
    if (balance > this.sessionPeak) this.sessionPeak = balance;

    // ── Daily loss tracking (reset at UTC midnight) ────────────────────────────
    const todayStr = new Date().toISOString().slice(0, 10);
    if (this.dayString !== todayStr) {
      this.dayString      = todayStr;
      this.dayStartBalance = balance;
      console.log(`[OracleLag] New day (${todayStr}) — daily loss reset. Start balance: $${balance.toFixed(2)}`);
    }
    if (!this.dayStartBalance) this.dayStartBalance = balance;

    // ── Daily loss circuit breaker ────────────────────────────────────────────
    const dailyLoss    = Math.max(0, this.dayStartBalance - balance);
    const maxDailyLoss = this.config.maxDailyLossUsdc || 15;
    if (dailyLoss >= maxDailyLoss) {
      console.log(`[OracleLag] ⛔ CIRCUIT BREAKER: daily loss $${dailyLoss.toFixed(2)} ≥ limit $${maxDailyLoss} — pausing trading for today`);
      this.paused = true;
      this.emit('circuit_breaker', { reason: 'daily_loss', dailyLoss, maxDailyLoss, balance });
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
      : price < 0.20 ? 0.12   // cautious — new zone, limited data
      : price < 0.30 ? 0.15   // 40% win rate zone — moderate size
      : price < 0.38 ? 0.25   // sweet spot — 67% win rate, confident size
      : 0.12;                  // above cap, shouldn't reach here

    // Apply drawdown scale + absolute per-bet cap when balance is low
    const balanceCap = balance < 30 ? 8 : balance < 40 ? 12 : this.config.maxPositionUsdc;
    const size = Math.min(balanceCap, available * fraction * drawdownScale);
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
      console.log(`[OracleLag] Executing GTC: BUY ${direction} $${size.toFixed(2)} @ ${fillPrice.toFixed(3)} (bid=${price.toFixed(3)}+${bidOffset}) depth=${depthShares.toFixed(0)}sh`);

      const { OrderType } = require('@polymarket/clob-client');
      const order = await this.poly.placeBuyOrder(tokenId, fillPrice, size, 0.01, false, OrderType.GTC);
      const orderId = order?.orderID || order?.errorMsg || JSON.stringify(order)?.slice(0, 200);
      console.log(`[OracleLag] GTC order placed: ${orderId} status=${order?.status} takenUSDC=${order?.takingAmount}`);

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
      this.emit('trade_executed', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        slug, marketUrl,
        tokenId, side: direction, price, size, orderId: order.orderID, path, ts: Date.now(),
      });

      setTimeout(async () => {
        try {
          await this.poly.cancelOrder(order.orderID);
          // Cancel succeeded — but only treat as "unfilled" if no tokens were received at placement.
          // If partially filled at placement (immediatelyFilled=true), tokens are in wallet — keep the log.
          if (!immediatelyFilled) {
            console.log(`[OracleLag] GTC order cancelled (unfilled): ${order.orderID}`);
            this.emit('trade_cancelled', { orderId: order.orderID });
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

  _recordTrade() { this.tradeTimestamps.push(Date.now()); }

  stop() {
    this.running = false;
    if (this.ws) this.ws.close();
    if (this.clobWs) this.clobWs.close();
  }
}

module.exports = { OracleLagArb };
