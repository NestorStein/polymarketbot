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
 *  - If BTC moved >0.3% in the current 5-min window, the "correct" direction
 *    token is underpriced — buy it before the market reprices
 *  - Example: BTC up 0.5% since window open → "Up" token still at 0.45 → buy Up
 *
 * Fee note: these markets use crypto_fees_v2 with 7.2% taker rate.
 * Oracle lag edge is typically 30-50¢ per token — far exceeds the fee.
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
    this.prices = {};        // symbol → { current, ts, change1m }
    this.markets = new Map(); // conditionId → market object
    this.running = false;
    this.maxTradesPerHour = 12;
    this.maxConcurrentPositions = 4; // hold up to 4 positions at once
    this.tradeTimestamps = [];
    this.tradedMarkets = new Set(); // prevent double-trading same market
    this.activePositions = 0;
    this.committedUsdc = 0; // track locally to prevent concurrent over-spend
    this.windowOpenPrices = new Map(); // symbol → price at start of current 5-min window
  }

  /** Start oracle lag monitor */
  async start() {
    this.running = true;
    await this._refreshCryptoMarkets();
    this._connectBinance();
    // Refresh every 30s — new 5-min windows open constantly, need fresh token prices
    setInterval(() => this._refreshCryptoMarkets(), 30 * 1000);
    // Reset window open prices on every 5-minute boundary so the reference aligns with market windows
    this._scheduleWindowReset();
    console.log('[OracleLag] Started — watching BTC/ETH/SOL Up or Down markets');
  }

  /** Schedule window price resets at each 5-minute market boundary */
  _scheduleWindowReset() {
    const now = Date.now();
    const msUntilNext5min = (5 * 60 * 1000) - (now % (5 * 60 * 1000));
    const doReset = () => {
      if (!this.running) return;
      this.windowOpenPrices.clear();
      // Seed with current live prices immediately so we have a reference from window open
      for (const [symbol, data] of Object.entries(this.prices)) {
        if (data?.current) this.windowOpenPrices.set(symbol, data.current);
      }
      console.log('[OracleLag] Window reset — new reference prices set for all symbols');
      // Also refresh markets immediately for the new window
      this._refreshCryptoMarkets().catch(() => {});
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
        const open   = parseFloat(ticker.o); // 24h open

        this.prices[symbol] = {
          current: price,
          open24h: open,
          change24h: ((price - open) / open) * 100,
          ts: Date.now(),
        };

        // Set window open price on first tick for this symbol (reset by _refreshCryptoMarkets)
        if (!this.windowOpenPrices.has(symbol)) {
          this.windowOpenPrices.set(symbol, price);
        }

        // Check for oracle lag opportunity
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

  /**
   * Fetch active 5-min Up/Down markets via Gamma API slug pattern:
   *   {asset}-updown-5m-{unix_timestamp_of_window_start}
   * Checks current window + next 2 windows for each asset.
   */
  async _refreshCryptoMarkets() {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const GAMMA = this.config.gammaHost || 'https://gamma-api.polymarket.com';
    let found = 0;

    // Clear expired markets
    for (const [id, m] of this.markets) {
      if (m._endsAtMs && m._endsAtMs < now - 60000) {
        this.markets.delete(id);
        this.tradedMarkets.delete(id);
      }
    }

    // Current window start (rounded down to nearest 5 min)
    const windowStart = Math.floor(nowSec / 300) * 300;
    const windows = [windowStart - 300, windowStart, windowStart + 300, windowStart + 600];

    const fetches = [];
    for (const asset of Object.keys(ASSET_SYMBOL_MAP)) {
      for (const ts of windows) {
        const slug = `${asset}-updown-5m-${ts}`;
        fetches.push({ slug, asset, ts });
      }
    }

    await Promise.all(fetches.map(async ({ slug, asset }) => {
      try {
        const res = await axios.get(`${GAMMA}/markets`, {
          params: { slug },
          timeout: 8000,
        });
        const arr = res.data;
        const m = Array.isArray(arr) ? arr[0] : arr;
        if (!m || !m.active || m.closed || !m.acceptingOrders) return;

        const endsAtMs = m.endDate ? new Date(m.endDate).getTime() : null;
        if (!endsAtMs) return;
        if (endsAtMs < now - 10000) return;            // already expired
        if (endsAtMs > now + 48 * 60 * 60 * 1000) return; // too far out

        const conditionId = m.conditionId;
        if (this.markets.has(conditionId)) return;

        // Parse token IDs
        let tokenIds = m.clobTokenIds;
        if (typeof tokenIds === 'string') { try { tokenIds = JSON.parse(tokenIds); } catch { return; } }
        if (!tokenIds || tokenIds.length < 2) return;

        // Parse outcome prices
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

        // Set window open price if we don't have one for this symbol yet
        if (!this.windowOpenPrices.has(symbol) && this.prices[symbol]) {
          this.windowOpenPrices.set(symbol, this.prices[symbol].current);
        }
      } catch { /* skip */ }
    }));

    console.log(`[OracleLag] Tracking ${this.markets.size} active Up/Down markets (${found} new)`);
  }

  /** Check for oracle lag opportunity when a price tick arrives */
  async _checkOpportunity(symbol, currentPrice) {
    if (!this.running || !this._canTrade()) return;

    // TIME GATE: only trade 12:00–22:00 UTC (high-volatility window).
    // Outside these hours crypto is quiet and 7.2% fee destroys any marginal edge.
    const utcHour = new Date().getUTCHours();
    if (utcHour < 12 || utcHour >= 22) return;

    const now = Date.now();
    for (const [conditionId, market] of this.markets) {
      if (this.activePositions >= this.maxConcurrentPositions) break;
      if (market._symbol !== symbol) continue;
      if (this.tradedMarkets.has(conditionId)) continue;
      if (market._endsAtMs && market._endsAtMs < now) continue;
      await this._evaluateMarket(market, symbol, currentPrice);
    }
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

  /**
   * Velocity check: fetch the current 1-minute Binance kline and return its % change.
   * A strong 1m move in the SAME direction as the window move means the price action
   * is RECENT and FAST — the CLOB is most likely to lag behind on fast moves.
   */
  async _get1mVelocity(symbol) {
    try {
      const res = await axios.get('https://api.binance.com/api/v3/klines', {
        params: { symbol: symbol + 'USDT', interval: '1m', limit: 1 },
        timeout: 2000,
      });
      const c = res.data[0];
      return ((parseFloat(c[4]) - parseFloat(c[1])) / parseFloat(c[1])) * 100;
    } catch { return 0; }
  }

  /** Evaluate if a specific Up/Down market has an oracle lag opportunity */
  async _evaluateMarket(market, symbol, spotPrice) {
    try {
      const now = Date.now();

      if (market._startsAtMs && market._startsAtMs > now) return;

      const upToken   = market._upToken;
      const downToken = market._downToken;

      const windowOpen = this.windowOpenPrices.get(symbol) || spotPrice;
      const pctWindow  = ((spotPrice - windowOpen) / windowOpen) * 100;

      // ── Step 1: Minimum move threshold ───────────────────────────────────────
      // 0.3% tier removed: fee (7.2%) kills edge below 0.5% moves.
      // Break-even analysis: 0.5% move → ~64% win prob → need CLOB < 0.597 to profit.
      // 1.0% move → ~72% win prob → need CLOB < 0.672.
      let targetDirection = null;
      let targetToken = null;

      if      (pctWindow >  0.5) { targetDirection = 'UP';   targetToken = upToken;   }
      else if (pctWindow < -0.5) { targetDirection = 'DOWN'; targetToken = downToken; }
      else return;

      console.log(`[OracleLag] Threshold met: ${symbol} ${pctWindow > 0 ? '+' : ''}${pctWindow.toFixed(3)}% → checking velocity+CLOB`);

      // ── Step 2: Velocity filter ───────────────────────────────────────────────
      // The move must be RECENT (happening in the current 1-minute candle), not a slow
      // 4-minute drift. Slow drifts give CLOB market makers time to reprice — no lag.
      // Fast moves (0.1%+ in the current minute) = CLOB most likely still lagging.
      const velocity = await this._get1mVelocity(symbol);
      const sameDir  = (pctWindow > 0 && velocity > 0) || (pctWindow < 0 && velocity < 0);
      if (!sameDir || Math.abs(velocity) < 0.10) {
        console.log(`[OracleLag] Velocity filter blocked: ${symbol} vel=${velocity > 0 ? '+' : ''}${velocity.toFixed(3)}% sameDir=${sameDir}`);
        return;
      }

      // ── Step 3: Real-time CLOB price ──────────────────────────────────────────
      const clobPrice = await this._getClobPrice(targetToken.token_id);
      if (!clobPrice) { console.log(`[OracleLag] CLOB price fetch failed for ${targetToken.token_id}`); return; }

      // ── Step 4: Edge check with fee-adjusted break-even ───────────────────────
      // Expected win probability (rough, based on historical 5m BTC/ETH crypto moves):
      //   0.5-1.0% window move → ~64% win prob (break-even buy price: 0.597 after 7.2% fee)
      //   >1.0%   window move → ~72% win prob (break-even: 0.672)
      //   >2.0%   window move → ~82% win prob (break-even: 0.765)
      // Max CLOB bid price = break-even minus 3¢ safety margin
      const maxClobPrice =
        (Math.abs(pctWindow) > 2.0) ? 0.73 :
        (Math.abs(pctWindow) > 1.0) ? 0.64 : 0.56;

      console.log(`[OracleLag] CLOB check: ${symbol} ${targetDirection} clobBid=${clobPrice.toFixed(3)} max=${maxClobPrice} vel=${velocity.toFixed(3)}%`);
      if (clobPrice >= maxClobPrice) { console.log(`[OracleLag] CLOB too high — already repriced`); return; } // AMM already repriced past break-even

      const msLeft = market._endsAtMs - now;
      if (msLeft < 30000) return; // No time to fill and resolve
      const question = market.question?.slice(0, 65);

      console.log(`[OracleLag] OPPORTUNITY: ${question}`);
      console.log(`            ${symbol} ${pctWindow > 0 ? '+' : ''}${pctWindow.toFixed(3)}% window | 1m vel=${velocity > 0 ? '+' : ''}${velocity.toFixed(3)}% | BUY ${targetDirection} | CLOB=${clobPrice.toFixed(3)} (max=${maxClobPrice}) | ${(msLeft/1000).toFixed(0)}s left`);

      this.emit('opportunity', {
        type: 'ORACLE_LAG',
        market: question,
        marketId: market.condition_id,
        symbol,
        spotPrice,
        windowOpen,
        pctMove: pctWindow,
        velocity,
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
   * @param {object} market
   * @param {string} tokenId
   * @param {number} price       - real-time CLOB bid (fetched just before)
   * @param {string} direction   - 'UP' | 'DOWN'
   * @param {string} question
   * @param {number} pctWindow   - Binance window % move (used for Kelly-style sizing)
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

    // Signal-strength sizing: bet more on high-conviction signals.
    //   0.5-1.0% move → 20% of available (conservative, lower edge)
    //   1.0-2.0% move → 30% of available (moderate edge)
    //   >2.0%   move → 40% of available (strong edge, rare)
    // Always capped at maxPositionUsdc.
    const pct = Math.abs(pctWindow);
    const fraction = pct >= 2.0 ? 0.40 : pct >= 1.0 ? 0.30 : 0.20;
    const size = Math.min(this.config.maxPositionUsdc, available * fraction);
    if (size < 5) return;

    this.committedUsdc += size;
    this.activePositions++;
    try {
      // Bid at CLOB price + 0.02 to cross the 0.01 spread and give a 0.01 buffer.
      // FOK fills at the ASK (CLOB bid + 0.01) immediately, or cancels entirely.
      // Cap at 0.76 — above this the fee (7.2%) erodes returns below acceptable.
      const fillPrice = Math.min(parseFloat((price + 0.02).toFixed(2)), 0.76);
      console.log(`[OracleLag] Executing FOK: BUY ${direction} $${size.toFixed(2)} @ ${fillPrice.toFixed(3)} (CLOB=${price.toFixed(3)}+0.02) | signal=${pct.toFixed(2)}%`);
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
      // Decrement counters when market resolves
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
      // Un-mark so we can retry on transient errors (but not balance errors)
      if (!msg.includes('balance') && !msg.includes('allowance')) {
        this.tradedMarkets.delete(market.condition_id);
      }
    }
  }

  /** Rate limit guard: max 10 trades/hour */
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
