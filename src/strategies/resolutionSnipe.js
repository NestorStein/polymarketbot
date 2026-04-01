'use strict';

/**
 * Resolution Snipe Strategy
 *
 * Buy near-certain contracts in the final 1-20 seconds before market close.
 * If outcome is already clear and token is at $0.85-$0.99, buy it — collect
 * the remaining spread with near-zero risk.
 *
 * Example: BTC is clearly above target price. YES token = $0.92.
 *          Buy $50 of YES → receive $54.35 at resolution = +$4.35 (8.7% in 20s)
 *
 * Combined with oracle lag: we identify the correct outcome EARLY,
 * then snipe in the final seconds when price converges but hasn't fully settled.
 */

const EventEmitter = require('events');

class ResolutionSnipe extends EventEmitter {
  constructor(config, polyClient, priceFeed) {
    super();
    this.config = config;
    this.poly = polyClient;
    this.priceFeed = priceFeed;
    this.watchedMarkets = new Map(); // marketId → market
    this.running = false;
    this.sniped = new Set(); // prevent double-sniping
  }

  /** Add a market to watch for resolution sniping */
  watchMarket(market) {
    if (market?.id) {
      this.watchedMarkets.set(market.id, market);
    }
  }

  /** Start the snipe monitor loop (checks every 5 seconds) */
  start() {
    this.running = true;
    this._loop();
    console.log('[Snipe] Resolution sniper started');
  }

  async _loop() {
    while (this.running) {
      await this._checkAll();
      await sleep(5000);
    }
  }

  async _checkAll() {
    for (const [id, market] of this.watchedMarkets) {
      if (this.sniped.has(id)) continue;

      const endsAt = market.endDate || market.game_start_time;
      if (!endsAt) continue;

      const msLeft = new Date(endsAt).getTime() - Date.now();

      // Only snipe in the 1s–20s window before close
      if (msLeft > 20000 || msLeft < 1000) continue;

      await this._evaluateSnipe(market, msLeft);
    }
  }

  async _evaluateSnipe(market, msLeft) {
    try {
      const tokens = market.tokens || [];
      const yesToken = tokens.find(t => t.outcome === 'Yes' || t.outcome === 'YES');
      const noToken  = tokens.find(t => t.outcome === 'No'  || t.outcome === 'NO');
      if (!yesToken || !noToken) return;

      const yesPrice = parseFloat(yesToken.price) || 0.5;
      const noPrice  = parseFloat(noToken.price)  || 0.5;

      // Find the dominant/near-certain side
      let snipeToken = null;
      let snipePrice = 0;
      let snipeSide = '';

      if (yesPrice >= 0.85 && yesPrice < 0.995) {
        snipeToken = yesToken;
        snipePrice = yesPrice;
        snipeSide  = 'YES';
      } else if (noPrice >= 0.85 && noPrice < 0.995) {
        snipeToken = noToken;
        snipePrice = noPrice;
        snipeSide  = 'NO';
      }

      if (!snipeToken) return;

      // Validate with crypto price if it's a crypto market
      const sym = this._detectCrypto(market.question || '');
      if (sym) {
        const priceData = this.priceFeed?.prices?.[sym];
        if (priceData) {
          const q = (market.question || '').toLowerCase();
          const aboveMatch = q.match(/above\s+\$?([\d,]+)/i);
          if (aboveMatch) {
            const target = parseFloat(aboveMatch[1].replace(',', ''));
            const isAbove = priceData.current > target;
            // Confirm our snipe matches reality
            if (snipeSide === 'YES' && !isAbove) return;
            if (snipeSide === 'NO'  &&  isAbove) return;
          }
        }
      }

      const profitPct = ((1.0 - snipePrice) / snipePrice) * 100;
      const question  = (market.question || '').slice(0, 60);

      console.log(`[Snipe] ${msLeft}ms left | ${question}`);
      console.log(`        ${snipeSide} @ ${snipePrice.toFixed(3)} → +${profitPct.toFixed(2)}% profit at resolution`);

      this.emit('opportunity', {
        type: 'RESOLUTION_SNIPE',
        market: question,
        marketId: market.id,
        side: snipeSide,
        price: snipePrice,
        profitPct,
        msLeft,
      });

      await this._executeTrade(market, snipeToken.token_id, snipePrice, snipeSide, question);
      this.sniped.add(market.id);

    } catch (err) {
      console.warn('[Snipe] Error:', err.message);
    }
  }

  async _executeTrade(market, tokenId, price, side, question) {
    const size = Math.min(this.config.maxPositionUsdc * 0.4, 20);
    if (size < 1) return;

    try {
      console.log(`[Snipe] BUY ${side} $${size} @ ${price} — ${question}`);
      const order = await this.poly.placeBuyOrder(tokenId, price, size, 0.01, !!market.negRisk);
      console.log(`[Snipe] Order: ${order?.orderID}`);
      this.emit('trade_executed', {
        type: 'RESOLUTION_SNIPE',
        market: question,
        side,
        price,
        size,
        orderId: order?.orderID,
        ts: Date.now(),
      });
    } catch (err) {
      console.error('[Snipe] Trade failed:', err.message);
    }
  }

  _detectCrypto(question) {
    const q = question.toLowerCase();
    if (q.includes('btc') || q.includes('bitcoin')) return 'BTC';
    if (q.includes('eth') || q.includes('ethereum')) return 'ETH';
    if (q.includes('sol') || q.includes('solana')) return 'SOL';
    return null;
  }

  stop() {
    this.running = false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { ResolutionSnipe };
