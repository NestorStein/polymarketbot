'use strict';

/**
 * Endgame Bond Strategy
 *
 * Buys near-certain outcome tokens ($0.88–$0.99) that are underpriced relative
 * to their actual resolution probability. Retail traders sell these early out of
 * fear, creating a predictable edge — especially on geopolitics (0% fee) markets.
 *
 * Key insight: A token at $0.94 on a 90%+ certain outcome is a 6.4% return
 * with very low risk. At scale, this compounds extremely well.
 *
 * Fee-aware: crypto markets at 1.8% taker fee need ~$0.965+ to be worth it.
 * Geopolitics at 0% fee — anything above $0.88 is tradeable.
 */

const EventEmitter = require('events');
const { PolymarketClient } = require('../polymarket');

const MIN_PRICE     = 0.88;  // below this, outcome is uncertain
const MAX_PRICE     = 0.985; // above this, spread < minimum fee
const MIN_HOURS_LEFT = 4;    // don't overlap with resolution sniper (<20s window)
const MAX_HOURS_LEFT = 168;  // 7 days max — don't hold too long
const MIN_NET_RETURN = 0.005; // 0.5% minimum net return after fees

class EndgameBond extends EventEmitter {
  constructor(config, poly, risk) {
    super();
    this.config = config;
    this.poly   = poly;
    this.risk   = risk;
    this.traded = new Set(); // prevent double-trading same market
  }

  /**
   * Evaluate a market for endgame bond opportunity.
   * Returns opportunity object or null.
   */
  evaluate(market) {
    if (this.traded.has(market.id)) return null;

    // Parse outcome prices
    let prices = market.outcomePrices || [];
    if (typeof prices === 'string') {
      try { prices = JSON.parse(prices); } catch { return null; }
    }
    if (!prices.length) return null;

    // Parse token IDs
    const tokenIds = PolymarketClient.parseTokenIds(market);
    if (tokenIds.length < 2) return null;

    // Parse outcomes
    let outcomes = market.outcomes || ['Yes', 'No'];
    if (typeof outcomes === 'string') {
      try { outcomes = JSON.parse(outcomes); } catch { outcomes = ['Yes', 'No']; }
    }

    // Check time remaining
    const endDate = market.endDate || market.end_date_iso;
    if (!endDate) return null;
    const msLeft = new Date(endDate).getTime() - Date.now();
    const hoursLeft = msLeft / 3600000;
    if (hoursLeft < MIN_HOURS_LEFT || hoursLeft > MAX_HOURS_LEFT) return null;

    // Find any outcome token in the sweet spot
    const category = PolymarketClient.categorizeMarket(market);
    const feeRate  = this.config.fees?.[category]?.taker ?? 0.01;

    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (isNaN(price) || price < MIN_PRICE || price > MAX_PRICE) continue;

      const netReturn = (1.0 - price - feeRate) / price;
      if (netReturn < MIN_NET_RETURN) continue;

      return {
        type: 'ENDGAME_BOND',
        marketId: market.id,
        market: market.question?.slice(0, 65),
        tokenId: tokenIds[i],
        outcome: outcomes[i] || (i === 0 ? 'Yes' : 'No'),
        price,
        hoursLeft: hoursLeft.toFixed(1),
        netReturn: (netReturn * 100).toFixed(2),
        category,
        feeRate,
        negRisk: !!market.negRisk,
        tickSize: parseFloat(market.orderPriceMinTickSize) || 0.01,
      };
    }

    return null;
  }

  async execute(opp, balance) {
    if (this.traded.has(opp.marketId)) return;
    this.traded.add(opp.marketId);

    const size = this.risk.sizePosition(
      // High confidence: price already implies ~90%+ probability
      Math.min(opp.price + 0.05, 0.95),
      balance,
      opp.price
    );
    if (size < 5) {
      console.log(`[Bond] Balance too low for endgame bond — skipping`);
      this.traded.delete(opp.marketId);
      return;
    }

    try {
      console.log(`[Bond] ${opp.outcome} @ $${opp.price} | +${opp.netReturn}% net | ${opp.hoursLeft}h left | ${opp.market}`);
      const order = await this.poly.placeBuyOrder(opp.tokenId, opp.price, size, opp.tickSize, opp.negRisk);
      const orderId = order?.orderID || JSON.stringify(order)?.slice(0, 50);
      console.log(`[Bond] ✅ Order: ${orderId}`);

      this.emit('opportunity', opp);
      this.emit('trade_executed', { ...opp, size, orderId: order?.orderID, ts: Date.now() });
    } catch (err) {
      const msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
      console.error('[Bond] Trade failed:', msg.slice(0, 120));
      this.traded.delete(opp.marketId);
    }
  }

  /** Clear old traded entries to prevent memory growth */
  pruneTraded(activeMarketIds) {
    for (const id of this.traded) {
      if (!activeMarketIds.has(id)) this.traded.delete(id);
    }
  }
}

module.exports = { EndgameBond };
