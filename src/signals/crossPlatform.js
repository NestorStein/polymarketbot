'use strict';

/**
 * Cross-platform prediction market signal source
 * Compares Polymarket prices vs Kalshi + Manifold Markets
 * When Kalshi/Manifold prices diverge from Polymarket → directional signal
 */

const axios = require('axios');

class CrossPlatformSignal {
  constructor(config) {
    this.kalshiBase = config.kalshiApiBase;
    this.kalshiEmail = config.kalshiEmail;
    this.kalshiPassword = config.kalshiPassword;
    this.manifoldBase = config.manifoldApiBase;
    this.kalshiToken = null;
    this.kalshiTokenExpiry = 0;
    this.cache = new Map();
    this.cacheTtl = 2 * 60 * 1000;
  }

  // ── Kalshi ─────────────────────────────────────────────────────────────────

  async getKalshiToken() {
    if (!this.kalshiEmail || !this.kalshiPassword) return null;
    if (this.kalshiToken && Date.now() < this.kalshiTokenExpiry) return this.kalshiToken;

    try {
      const res = await axios.post(`${this.kalshiBase}/login`, {
        email: this.kalshiEmail,
        password: this.kalshiPassword,
      }, { timeout: 8000 });
      this.kalshiToken = res.data.token;
      this.kalshiTokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
      return this.kalshiToken;
    } catch {
      return null;
    }
  }

  /** Search Kalshi for events matching a keyword (works with or without auth) */
  async searchKalshi(keyword) {
    const cacheKey = `kalshi:${keyword}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtl) return cached.data;

    const token = await this.getKalshiToken(); // null if no credentials
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    try {
      const res = await axios.get(`${this.kalshiBase}/markets`, {
        params: { limit: 10, status: 'open', search: keyword },
        headers,
        timeout: 8000,
      });

      const data = res.data?.markets || [];
      this.cache.set(cacheKey, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  /** Get Kalshi implied probability for best matching market */
  async getKalshiPrice(keyword) {
    const markets = await this.searchKalshi(keyword);
    if (!markets || markets.length === 0) return null;

    const m = markets[0];
    // yes_bid/no_ask in cents, or as decimals depending on endpoint
    const yesBid = (m.yes_bid > 1 ? m.yes_bid / 100 : m.yes_bid) || 0;
    const noAsk  = (m.no_ask  > 1 ? m.no_ask  / 100 : m.no_ask)  || 1;
    const impliedYes = (yesBid + (1 - noAsk)) / 2;
    if (impliedYes <= 0 || impliedYes >= 1) return null;
    return { probability: impliedYes, market: m.title, ticker: m.ticker };
  }

  // ── Manifold Markets ───────────────────────────────────────────────────────

  /** Search Manifold for markets matching a keyword */
  async searchManifold(keyword) {
    const cacheKey = `manifold:${keyword}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtl) return cached.data;

    try {
      const res = await axios.get(`${this.manifoldBase}/search-markets`, {
        params: { term: keyword, sort: 'liquidity', limit: 5 },
        timeout: 8000,
      });

      const data = res.data || [];
      this.cache.set(cacheKey, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  /** Get Manifold implied probability for best matching market */
  async getManifoldPrice(keyword) {
    const markets = await this.searchManifold(keyword);
    if (!markets || markets.length === 0) return null;

    // Find BINARY markets only
    const binary = markets.find(m => m.outcomeType === 'BINARY');
    if (!binary) return null;

    return {
      probability: binary.probability,
      market: binary.question,
      url: binary.url,
    };
  }

  // ── Combined signal ────────────────────────────────────────────────────────

  /**
   * Compare Polymarket price vs other platforms.
   * Returns { signal: 'YES'|'NO'|'NEUTRAL', confidence, sources }
   */
  async getCrossPlatformSignal(keyword, polymarketYesPrice) {
    const [kalshi, manifold] = await Promise.all([
      this.getKalshiPrice(keyword).catch(() => null),
      this.getManifoldPrice(keyword).catch(() => null),
    ]);

    const sources = [];
    const signals = [];

    if (kalshi) {
      const diff = kalshi.probability - polymarketYesPrice;
      sources.push({ platform: 'Kalshi', price: kalshi.probability, diff, market: kalshi.market });
      if (Math.abs(diff) > 0.04) {
        signals.push(diff > 0 ? 'YES' : 'NO');
      }
    }

    if (manifold) {
      const diff = manifold.probability - polymarketYesPrice;
      sources.push({ platform: 'Manifold', price: manifold.probability, diff, market: manifold.market });
      if (Math.abs(diff) > 0.06) {
        signals.push(diff > 0 ? 'YES' : 'NO');
      }
    }

    if (signals.length === 0) {
      return { signal: 'NEUTRAL', confidence: 0, sources };
    }

    const yesCount = signals.filter(s => s === 'YES').length;
    const noCount  = signals.filter(s => s === 'NO').length;
    const signal = yesCount > noCount ? 'YES' : 'NO';
    const confidence = Math.max(yesCount, noCount) / signals.length;

    return { signal, confidence, sources };
  }
}

module.exports = { CrossPlatformSignal };
