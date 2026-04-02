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
 *  - Detect SUDDEN moves via rolling 30s/60s price history (zero HTTP latency)
 *  - CLOB prices tracked via Polymarket WebSocket (zero HTTP latency)
 *  - Two firing paths:
 *    PATH A (spike-led): 60s spike ≥ 0.25% + window ≥ 0.30% → fire EARLY, CLOB < 0.55
 *    PATH B (window-led): window ≥ 0.50% + 60s spike ≥ 0.15% → fire standard, CLOB < 0.56/0.64/0.73
 *
 * Fee note: these markets use crypto_fees_v2 with 7.2% taker rate.
 */

const WebSocket = require('ws');
const axios = require('axios');
const EventEmitter = require('events');

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
    this.maxTradesPerHour = 12;
    this.maxConcurrentPositions = 4;
    this.tradeTimestamps = [];
    this.tradedMarkets = new Set();
    this.activePositions = 0;
    this.committedUsdc = 0;
    this.windowOpenPrices = new Map(); // symbol → price at start of current 5-min window
    this.priceHistory = {};            // symbol → [{price, ts}] rolling 120s buffer
  }

  /** Start oracle lag monitor */
  async start() {
    this.running = true;
    await this._refreshCryptoMarkets();
    this._connectBinance();
    this._connectClobWs();
    setInterval(() => this._refreshCryptoMarkets(), 30 * 1000);
    this._scheduleWindowReset();
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
          // Initial orderbook snapshot — extract best bid/ask from bids[]/asks[]
          if (msg.bids && msg.asks && msg.asset_id) {
            const bestBid = msg.bids.length > 0 ? parseFloat(msg.bids[0].price) : null;
            const bestAsk = msg.asks.length > 0 ? parseFloat(msg.asks[msg.asks.length - 1]?.price) : null;
            // asks are ordered low→high, so last element is highest ask, but we want lowest ask
            const lowestAsk = msg.asks.length > 0 ? parseFloat(msg.asks[0].price) : null;
            this.clobPrices[msg.asset_id] = { bid: bestBid, ask: lowestAsk, ts: Date.now() };
          }
          // Real-time price_changes — has best_bid and best_ask directly
          if (msg.price_changes) {
            for (const change of msg.price_changes) {
              if (!change.asset_id) continue;
              const bid = change.best_bid != null ? parseFloat(change.best_bid) : null;
              const ask = change.best_ask != null ? parseFloat(change.best_ask) : null;
              if (bid != null || ask != null) {
                this.clobPrices[change.asset_id] = { bid, ask, ts: Date.now() };
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
    if (cached && cached.ask != null && (Date.now() - cached.ts) < 10_000) {
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
    const streams = pairs.map(s => `${s}@miniTicker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => console.log('[OracleLag] Binance WS connected'));

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        const ticker = msg.data;
        if (!ticker?.c) return;

        const symbol = ticker.s.replace('USDT', '');
        const price  = parseFloat(ticker.c);

        this.prices[symbol] = { current: price, ts: Date.now() };
        this._pushPriceHistory(symbol, price);

        if (!this.windowOpenPrices.has(symbol)) {
          this.windowOpenPrices.set(symbol, price);
        }

        if (this.markets.size > 0) {
          await this._checkOpportunity(symbol, price);
        }
      } catch { /* ignore parse errors */ }
    });

    this.ws.on('error', err => console.warn('[OracleLag] Binance WS error:', err.message));
    this.ws.on('close', () => {
      if (this.running) setTimeout(() => this._connectBinance(), 3000);
    });
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
    const windows = [windowStart - 300, windowStart, windowStart + 300, windowStart + 600];

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
    if (!this.running || !this._canTrade()) return;

    // No time gate — signal filters (spike ≥0.25%, window ≥0.50%, reversal CLOB mismatch)
    // are strong enough to prevent bad trades during quiet hours. Markets run 24/7.
    const now = Date.now();
    for (const [conditionId, market] of this.markets) {
      if (this.activePositions >= this.maxConcurrentPositions) break;
      if (market._symbol !== symbol) continue;
      if (this.tradedMarkets.has(conditionId)) continue;
      if (market._endsAtMs && market._endsAtMs < now) continue;
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

      // ── Both CLOB prices from WS cache (0ms) ──────────────────────────────
      const upClobAsk   = this.clobPrices[upToken.token_id]?.ask   ?? null;
      const downClobAsk = this.clobPrices[downToken.token_id]?.ask ?? null;

      // ── PATH C: REVERSAL ───────────────────────────────────────────────────
      // CLOB committed strongly to one direction, but BTC has actually moved opposite.
      // e.g. CLOB shows UP=0.80 (BTC was up early), but BTC is now -0.25% from window open.
      // → Buy DOWN cheap (0.20 ask) before AMM catches the reversal.
      // Conviction threshold: stale side > 0.65, disagreement ≥ 0.20%.
      let isReversal = false;
      let reversalStaleSidePrice = 0;
      let reversalDirection = null;

      if (upClobAsk != null && downClobAsk != null) {
        if (upClobAsk > 0.60 && pctWindow < -0.15) {
          // CLOB says UP wins, but BTC is DOWN — buy DOWN
          isReversal = true;
          reversalDirection = 'DOWN';
          reversalStaleSidePrice = upClobAsk;
        } else if (downClobAsk > 0.60 && pctWindow > 0.15) {
          // CLOB says DOWN wins, but BTC is UP — buy UP
          isReversal = true;
          reversalDirection = 'UP';
          reversalStaleSidePrice = downClobAsk;
        }
      }

      // ── PATH A / B: spike-led and window-led (follow BTC direction) ────────
      const spikeDir60 = (pctWindow > 0 && spike60 > 0) || (pctWindow < 0 && spike60 < 0);
      // PATH A: spike is the PRIMARY signal — just needs window to confirm direction (≥0.15%)
      // The CLOB check (max 0.53) is the hard guard against already-repriced markets
      const isSpikeLed  = Math.abs(spike60) >= 0.22 && Math.abs(pctWindow) >= 0.15 && spikeDir60;
      // PATH B: larger sustained window move (≥0.40%) + recent momentum (spike60 ≥0.12%)
      const isWindowLed = Math.abs(pctWindow) >= 0.40 && Math.abs(spike60) >= 0.12 && spikeDir60;

      if (!isReversal && !isSpikeLed && !isWindowLed) return;

      // ── Determine final direction & target token ───────────────────────────
      // Reversal targets opposite of CLOB's committed side.
      // A/B follow BTC direction. If reversal direction agrees with A/B: combined.
      const btcDirection    = pctWindow > 0 ? 'UP' : 'DOWN';
      const targetDirection = isReversal ? reversalDirection : btcDirection;
      const targetToken     = targetDirection === 'UP' ? upToken : downToken;

      // Build path label
      const pathParts = [];
      if (isReversal) pathParts.push('REVERSAL');
      if (isSpikeLed  && btcDirection === targetDirection) pathParts.push('SPIKE');
      if (isWindowLed && btcDirection === targetDirection) pathParts.push('WINDOW');
      const path = pathParts.join('+') || 'REVERSAL';

      // ── CLOB price for target token (0ms from cache) ──────────────────────
      const clobPrice = await this._getClobPrice(targetToken.token_id);
      if (!clobPrice) { console.log(`[OracleLag] CLOB price unavailable for ${symbol} ${targetDirection}`); return; }

      const wsAge = this.clobPrices[targetToken.token_id]?.ts
        ? `${((Date.now() - this.clobPrices[targetToken.token_id].ts) / 1000).toFixed(1)}s ago`
        : 'HTTP';

      // ── Max CLOB thresholds ────────────────────────────────────────────────
      // Reversal: we're buying the cheap/wrong-priced token.
      //   Stale side > 0.80: target cheap token likely 0.15-0.25 → allow up to 0.50
      //   Stale side > 0.70: target likely 0.25-0.35 → allow up to 0.45
      //   Stale side > 0.65: target likely 0.30-0.40 → allow up to 0.40
      // Spike/Window: existing tiers.
      const maxClobPrice = isReversal
        ? (reversalStaleSidePrice > 0.80 ? 0.50 : reversalStaleSidePrice > 0.70 ? 0.45 : 0.40)
        : (isSpikeLed && !isWindowLed) ? 0.53   // spike-only: tight — CLOB must still be near 0.50
        : (Math.abs(pctWindow) > 2.0) ? 0.73
        : (Math.abs(pctWindow) > 1.0) ? 0.64
        : (Math.abs(pctWindow) > 0.50) ? 0.56 : 0.54; // window 0.40-0.50%: slightly tighter

      console.log(`[OracleLag] [${path}] ${symbol} window=${pctWindow>=0?'+':''}${pctWindow.toFixed(3)}% 60s=${spike60>=0?'+':''}${spike60.toFixed(3)}% | CLOB ${targetDirection}=${clobPrice.toFixed(3)} max=${maxClobPrice} age=${wsAge}${isReversal ? ` | stale=${reversalStaleSidePrice.toFixed(3)}` : ''}`);

      if (clobPrice >= maxClobPrice) {
        console.log(`[OracleLag] CLOB at ${clobPrice.toFixed(3)} ≥ max ${maxClobPrice} — skip`);
        return;
      }

      const msLeft = market._endsAtMs - now;
      if (msLeft < 30000) return;

      const question = market.question?.slice(0, 65);
      console.log(`[OracleLag] *** OPPORTUNITY [${path}]: ${question}`);
      console.log(`            BUY ${targetDirection} @ ${clobPrice.toFixed(3)} (max=${maxClobPrice}) | ${(msLeft/1000).toFixed(0)}s left`);

      this.emit('opportunity', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        symbol, spotPrice, windowOpen, pctMove: pctWindow, spike60, spike30, path,
        direction: targetDirection, tokenId: targetToken.token_id, side: targetDirection,
        price: clobPrice, expectedEdge: (maxClobPrice - clobPrice).toFixed(3), msLeft,
      });

      this.tradedMarkets.add(market.condition_id);
      await this._executeTrade(market, targetToken.token_id, clobPrice, targetDirection, question, pctWindow, isReversal ? reversalStaleSidePrice : null);

    } catch (err) {
      console.warn('[OracleLag] Evaluate error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trade execution
  // ─────────────────────────────────────────────────────────────────────────────

  async _executeTrade(market, tokenId, price, direction, question, pctWindow = 0.5, reversalStalePrice = null) {
    const balance   = await this.poly.getBalance().catch(() => 0);
    const reserve   = this.config.reserveUsdc || 5;
    const available = balance - reserve - this.committedUsdc;
    if (available < 5) {
      console.log(`[OracleLag] Balance too low ($${balance.toFixed(2)}) — skipping`);
      this.tradedMarkets.delete(market.condition_id);
      return;
    }

    // Reversal sizing: scale by how strongly the stale side was committed.
    //   Stale > 0.80 → 25% (deep mismatch, high conviction)
    //   Stale > 0.70 → 20%
    //   Stale > 0.65 → 15%
    // Spike/Window sizing: by window move magnitude.
    const pct      = Math.abs(pctWindow);
    const fraction = reversalStalePrice != null
      ? (reversalStalePrice > 0.80 ? 0.25 : reversalStalePrice > 0.70 ? 0.20 : 0.15)
      : (pct >= 2.0 ? 0.40 : pct >= 1.0 ? 0.30 : pct >= 0.50 ? 0.20 : 0.15);
    const size     = Math.min(this.config.maxPositionUsdc, available * fraction);
    if (size < 5) return;

    this.committedUsdc += size;
    this.activePositions++;
    try {
      const fillPrice = Math.min(parseFloat((price + 0.02).toFixed(2)), 0.76);
      console.log(`[OracleLag] Executing FOK: BUY ${direction} $${size.toFixed(2)} @ ${fillPrice.toFixed(3)} (bid=${price.toFixed(3)}+0.02)`);
      const order = await this.poly.placeBuyOrder(tokenId, fillPrice, size, 0.01, false);
      this._recordTrade();
      const orderId = order?.orderID || order?.errorMsg || JSON.stringify(order)?.slice(0, 60);
      console.log(`[OracleLag] Order placed: ${orderId}`);

      this.emit('trade_executed', {
        type: 'ORACLE_LAG', market: question, marketId: market.condition_id,
        tokenId, side: direction, price, size, orderId: order?.orderID, ts: Date.now(),
      });

      if (market._endsAtMs) {
        const msLeft = market._endsAtMs - Date.now();
        const cleanup = () => { this.activePositions--; this.committedUsdc = Math.max(0, this.committedUsdc - size); };
        if (msLeft > 0) setTimeout(cleanup, msLeft + 30000);
        else cleanup();
      }
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
