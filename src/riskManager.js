'use strict';

/**
 * Risk manager — position sizing, exposure limits, P&L tracking
 */

class RiskManager {
  constructor(config) {
    this.config = config;
    this.positions = new Map();  // marketId → { tokenId, side, cost, shares, entryPrice }
    this.totalInvested = 0;
    this.realizedPnl = 0;
    this.trades = [];
    this.startBalance = 0;
  }

  setStartBalance(bal) {
    this.startBalance = bal;
  }

  /**
   * Kelly Criterion position sizing (fractional Kelly at 25%)
   * f* = (p*b - q) / b  where b = net odds = (1-price)/price
   * @param {number} confidence  estimated win probability (0–1)
   * @param {number} availableUsdc  current cash balance
   * @param {number} price  token price (default 0.5 if unknown)
   */
  sizePosition(confidence, availableUsdc, price = 0.5) {
    const tradeable = availableUsdc - this.config.reserveUsdc;
    if (tradeable <= 0) return 0;

    const p = Math.min(Math.max(confidence, 0.01), 0.99);
    const q = 1 - p;
    const b = (1 - price) / Math.max(price, 0.01);   // net odds
    const fullKelly = (p * b - q) / b;               // Kelly fraction
    const fraction  = Math.min(Math.max(fullKelly * 0.25, 0), 0.20); // 25% Kelly, cap at 20%

    const size = Math.min(
      fraction * tradeable,
      this.config.maxPositionUsdc
    );

    return Math.max(5, Math.round(size * 100) / 100); // min $5 (CLOB minimum)
  }

  /** Check if we can open a new position */
  canTrade(marketId) {
    // Don't double-up in same market
    if (this.positions.has(marketId)) return false;
    // Max 5 concurrent positions
    if (this.positions.size >= 5) return false;
    return true;
  }

  /** Record a position opened */
  openPosition(marketId, tokenId, side, cost, shares, entryPrice) {
    this.positions.set(marketId, { tokenId, side, cost, shares, entryPrice, openedAt: Date.now() });
    this.totalInvested += cost;
    this.trades.push({
      type: 'OPEN',
      marketId,
      side,
      cost,
      shares,
      entryPrice,
      ts: Date.now(),
    });
  }

  /** Record a position closed */
  closePosition(marketId, exitPrice, payout) {
    const pos = this.positions.get(marketId);
    if (!pos) return 0;

    const pnl = payout - pos.cost;
    this.realizedPnl += pnl;
    this.totalInvested -= pos.cost;
    this.positions.delete(marketId);

    this.trades.push({
      type: 'CLOSE',
      marketId,
      side: pos.side,
      cost: pos.cost,
      payout,
      pnl,
      ts: Date.now(),
    });

    return pnl;
  }

  getStats() {
    return {
      openPositions: this.positions.size,
      totalInvested: this.totalInvested,
      realizedPnl: this.realizedPnl,
      tradeCount: this.trades.filter(t => t.type === 'OPEN').length,
      winCount: this.trades.filter(t => t.type === 'CLOSE' && t.pnl > 0).length,
      lossCount: this.trades.filter(t => t.type === 'CLOSE' && t.pnl < 0).length,
      positions: Array.from(this.positions.entries()).map(([id, p]) => ({
        marketId: id,
        ...p,
        ageMs: Date.now() - p.openedAt,
      })),
      recentTrades: this.trades.slice(-20),
    };
  }
}

module.exports = { RiskManager };
