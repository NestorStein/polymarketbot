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
 *  - Detect SUDDEN moves via rolling 30s/60s price history (not slow cumulative drifts)
 *  - Two firing paths:
 *    PATH A (spike-led): 60s spike ≥ 0.25% + window ≥ 0.30% → fire EARLY, CLOB < 0.55
 *    PATH B (window-led): window ≥ 0.50% + 60s spike ≥ 0.15% → fire standard, CLOB < 0.56/0.64/0.73
 *
 * Fee note: these markets use crypto_fees_v2 with 7.2% taker rate.
 */

const WebSocket = require('ws');
const axios = require('axios');
const EventEmitter = require('events');

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
    this.ws = null;
    this.prices = {};        // symbol → { current, ts }
    this.markets = new Map(); // conditionId → market object
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

  /** Connect Binance WebSocket for real-time spot prices */
  _connectBinance() {
    const pairs = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'dogeusdt', 'bnbusdt'];
    const streams = pairs.map(s => `${s}@miniTicker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[OracleLag] Binance WS connected');
    });

    this.ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        const ticker = msg.data;
        if (!ticker?.c) return;

        const symbol = ticker.s.replace('USDT', '');
        const price  = parseFloat(ticker.c);

        this.prices[symbol] = { current: price, ts: Date.now() };

        // Maintain rolling 120s price history (used for spike detection)
        this._pushPriceHistory(symbol, price);

        // Set window open price on first tick for this symbol
        if (!this.windowOpenPrices.has(symbol)) {
          this.windowOpenPrices.set(symbol, price);
        }

        if (this.markets.size > 0) {
          await this._checkOpportunity(symbol, price);
        }
      } catch { /* ignore parse errors */ }
    });

    this.ws.on('error', err => console.warn('[OracleLag] WS error:', err.message));
    this.ws.on('close', () => {
      if (this.running) setTimeout(() => this._connectBinance(), 3000);
    });
  }

  /** Push price into rolling history, trim entries older than 120s */
  _pushPriceHistory(symbol, price) {
    if (!this.priceHistory[symbol]) this.priceHistory[symbol] = [];
    const now = Date.now();
    this.priceHistory[symbol].push({ price, ts: now });
    // Trim to last 120 seconds
    const cutoff = now - 120_000;
    const hist = this.priceHistory[symbol];
    let i = 0;
    while (i < hist.length - 1 && hist[i].ts < cutoff) i++;
    if (i > 0) this.priceHistory[symbol] = hist.slice(i);
  }

  /**
   * Return the % price move over the last `secondsAgo` seconds.
   * Synchronous — uses in-memory history, zero HTTP latency.
   * Returns 0 if insufficient history.
   */
  _getRecentMove(symbol, secondsAgo) {
    const hist = this.priceHistory[symbol];
    if (!hist || hist.length < 2) return 0;
    const now = Date.now();
    const targetTs = now - secondsAgo * 1000;
    // Find the most recent entry that is at least secondsAgo old
    let oldEntry = null;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].ts <= targetTs) { oldEntry = hist[i]; break; }
    }
    if (!oldEntry) return 0; // not enough history yet
    const current = hist[hist.length - 1];
    return ((current.price - oldEntry.price) / oldEntry.price) * 100;
  }

  /** Seconds of price history available for a symbol */
  _historyAge(symbol) {
    const hist = this.priceHistory[symbol];
    if (!hist || hist.length < 2) return 0;
    return (hist[hist.length - 1].ts - hist[0].ts) / 1000;
  }

  /**
   * Fetch active 5-min Up/Down markets via Gamma API slug pattern.
   */
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

        if (!this.windowOpenPrices.has(symbol) && this.prices[symbol]) {
          this.windowOpenPrices.set(symbol, this.prices[symbol].current);
        }
      } catch { /* skip */ }
    }));

    console.log(`[OracleLag] Tracking ${this.markets.size} active Up/Down markets (${found} new)`);
  }

  /** Fetch real-time CLOB buy-side bid for a token */
  async _getClobPrice(tokenId) {
    try {
      const res = await axios.get('https://clob.polymarket.com/price', {
        params: { token_id: tokenId, side: 'buy' },
        timeout: 2000,
      });
      const p = parseFloat(res.data?.price);
      return isNaN(p) ? null : p;
    } catch { return null; }
  }

  /** Check for oracle lag opportunity when a price tick arrives */
  async _checkOpportunity(symbol, currentPrice) {
    if (!this.running || !this._canTrade()) return;

    // TIME GATE: 06:00–23:00 UTC covers Asian open, European session, and full US session.
    const utcHour = new Date().getUTCHours();
    if (utcHour < 6 || utcHour >= 23) return;

    const now = Date.now();
    for (const [conditionId, market] of this.markets) {
      if (this.activePositions >= this.maxConcurrentPositions) break;
      if (market._symbol !== symbol) continue;
      if (this.tradedMarkets.has(conditionId)) continue;
      if (market._endsAtMs && market._endsAtMs < now) continue;
      await this._evaluateMarket(market, symbol, currentPrice);
    }
  }

  /** Evaluate if a specific Up/Down market has an oracle lag opportunity */
  async _evaluateMarket(market, symbol, spotPrice) {
    try {
      const now = Date.now();
      if (market._startsAtMs && market._startsAtMs > now) return;

      const upToken   = market._upToken;
      const downToken = market._downToken;

      // ── Window move (from 5-min boundary open) ────────────────────────────
      const windowOpen = this.windowOpenPrices.get(symbol) || spotPrice;
      const pctWindow  = ((spotPrice - windowOpen) / windowOpen) * 100;

      // ── Recent spike detection (synchronous, zero HTTP cost) ───────────────
      // Need at least 25s of history for spike60 to be meaningful
      const histAge = this._historyAge(symbol);
      const spike60 = histAge >= 25 ? this._getRecentMove(symbol, 60) : 0;
      const spike30 = histAge >= 15 ? this._getRecentMove(symbol, 30) : 0;

      // Direction alignment: spike must agree with window move
      const windowUp   = pctWindow > 0;
      const spikeDir60 = (windowUp && spike60 > 0) || (!windowUp && spike60 < 0);
      const spikeDir30 = (windowUp && spike30 > 0) || (!windowUp && spike30 < 0);

      // ── PATH A: Spike-led signal ──────────────────────────────────────────
      // 60s spike ≥ 0.25% + window confirms direction ≥ 0.30%
      // Fire EARLY — CLOB almost certainly still at ~0.50
      const isSpikeLed = Math.abs(spike60) >= 0.25
                      && Math.abs(pctWindow) >= 0.30
                      && spikeDir60;

      // ── PATH B: Window-led signal ─────────────────────────────────────────
      // Standard ≥ 0.50% window move PLUS must have recent momentum (not slow drift)
      // Require 60s spike ≥ 0.15% to confirm move is still fresh
      const isWindowLed = Math.abs(pctWindow) >= 0.50
                       && Math.abs(spike60) >= 0.15
                       && spikeDir60;

      if (!isSpikeLed && !isWindowLed) return;

      // Determine signal path and direction
      const path = isSpikeLed && !isWindowLed ? 'SPIKE' : isWindowLed && !isSpikeLed ? 'WINDOW' : 'BOTH';
      const targetDirection = pctWindow > 0 ? 'UP' : 'DOWN';
      const targetToken     = pctWindow > 0 ? upToken : downToken;

      console.log(`[OracleLag] SIGNAL [${path}]: ${symbol} window=${pctWindow > 0 ? '+' : ''}${pctWindow.toFixed(3)}% | 60s=${spike60 > 0 ? '+' : ''}${spike60.toFixed(3)}% | 30s=${spike30 > 0 ? '+' : ''}${spike30.toFixed(3)}% → checking CLOB`);

      // ── CLOB price check ──────────────────────────────────────────────────
      const clobPrice = await this._getClobPrice(targetToken.token_id);
      if (!clobPrice) { console.log(`[OracleLag] CLOB fetch failed`); return; }

      // Max CLOB thresholds by signal strength:
      //   SPIKE-led only (lower window move): conservative max 0.55
      //   Window ≥ 0.5–1.0%: 0.56
      //   Window ≥ 1.0–2.0%: 0.64
      //   Window ≥ 2.0%:     0.73
      const maxClobPrice = (isSpikeLed && !isWindowLed) ? 0.55 :
        (Math.abs(pctWindow) > 2.0) ? 0.73 :
        (Math.abs(pctWindow) > 1.0) ? 0.64 : 0.56;

      console.log(`[OracleLag] CLOB check: ${symbol} ${targetDirection} bid=${clobPrice.toFixed(3)} max=${maxClobPrice}`);
      if (clobPrice >= maxClobPrice) {
        console.log(`[OracleLag] CLOB already repriced (${clobPrice.toFixed(3)} ≥ ${maxClobPrice}) — skip`);
        return;
      }

      const msLeft = market._endsAtMs - now;
      if (msLeft < 30000) return;

      const question = market.question?.slice(0, 65);
      console.log(`[OracleLag] OPPORTUNITY [${path}]: ${question}`);
      console.log(`            ${symbol} window=${pctWindow > 0 ? '+' : ''}${pctWindow.toFixed(3)}% | 60s=${spike60 > 0 ? '+' : ''}${spike60.toFixed(3)}% | 30s=${spike30 > 0 ? '+' : ''}${spike30.toFixed(3)}% | BUY ${targetDirection} @ CLOB=${clobPrice.toFixed(3)} (max=${maxClobPrice}) | ${(msLeft/1000).toFixed(0)}s left`);

      this.emit('opportunity', {
        type: 'ORACLE_LAG',
        market: question,
        marketId: market.condition_id,
        symbol,
        spotPrice,
        windowOpen,
        pctMove: pctWindow,
        spike60,
        spike30,
        path,
        direction: targetDirection,
        tokenId: targetToken.token_id,
        side: targetDirection,
        price: clobPrice,
        expectedEdge: (maxClobPrice - clobPrice).toFixed(3),
        msLeft,
      });

      this.tradedMarkets.add(market.condition_id);
      await this._executeTrade(market, targetToken.token_id, clobPrice, targetDirection, question, pctWindow);

    } catch (err) {
      console.warn('[OracleLag] Evaluate error:', err.message);
    }
  }

  /**
   * Execute an oracle lag trade.
   */
  async _executeTrade(market, tokenId, price, direction, question, pctWindow = 0.5) {
    const balance = await this.poly.getBalance().catch(() => 0);
    const reserve = this.config.reserveUsdc || 5;
    const available = balance - reserve - this.committedUsdc;
    if (available < 5) {
      console.log(`[OracleLag] Balance too low ($${balance.toFixed(2)}, committed: $${this.committedUsdc.toFixed(2)}) — skipping`);
      this.tradedMarkets.delete(market.condition_id);
      return;
    }

    // Signal-strength sizing:
    //   spike-led (0.30-0.50% window): 15% — smaller bet, lower win probability
    //   0.50-1.0% window: 20%
    //   1.0-2.0% window: 30%
    //   >2.0% window:    40%
    const pct = Math.abs(pctWindow);
    const fraction = pct >= 2.0 ? 0.40 : pct >= 1.0 ? 0.30 : pct >= 0.50 ? 0.20 : 0.15;
    const size = Math.min(this.config.maxPositionUsdc, available * fraction);
    if (size < 5) return;

    this.committedUsdc += size;
    this.activePositions++;
    try {
      const fillPrice = Math.min(parseFloat((price + 0.02).toFixed(2)), 0.76);
      console.log(`[OracleLag] Executing FOK: BUY ${direction} $${size.toFixed(2)} @ ${fillPrice.toFixed(3)} (CLOB=${price.toFixed(3)}+0.02) | signal=${pct.toFixed(3)}%`);
      const order = await this.poly.placeBuyOrder(tokenId, fillPrice, size, 0.01, false);
      this._recordTrade();
      const orderId = order?.orderID || order?.errorMsg || JSON.stringify(order)?.slice(0, 60);
      console.log(`[OracleLag] Order placed: ${orderId}`);

      this.emit('trade_executed', {
        type: 'ORACLE_LAG',
        market: question,
        marketId: market.condition_id,
        tokenId,
        side: direction,
        price,
        size,
        orderId: order?.orderID,
        ts: Date.now(),
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

  /** Rate limit guard */
  _canTrade() {
    const now = Date.now();
    this.tradeTimestamps = this.tradeTimestamps.filter(t => now - t < 3600000);
    return this.tradeTimestamps.length < this.maxTradesPerHour;
  }

  _recordTrade() {
    this.tradeTimestamps.push(Date.now());
  }

  stop() {
    this.running = false;
    if (this.ws) this.ws.close();
  }
}

module.exports = { OracleLagArb };
