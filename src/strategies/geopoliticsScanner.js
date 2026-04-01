'use strict';

/**
 * Geopolitics Market Scanner
 *
 * Polymarket geopolitics markets have 0% taker fees (effective March 30, 2026).
 * This scanner fetches them from Gamma API using tag/keyword filters.
 * These markets flow into the normal scan pipeline and benefit from:
 *  - Complement arb (0% fee → even 0.5¢ gap is profitable)
 *  - Endgame bond (0% fee → threshold drops to $0.88)
 *  - Signal trades (0% fee → lower confidence threshold viable)
 */

const axios = require('axios');

const GEO_TAGS = ['geopolitics', 'international', 'war', 'diplomacy', 'foreign-policy'];

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

class GeopoliticsScanner {
  constructor(config) {
    this.config    = config;
    this.cache     = [];
    this.lastFetch = 0;
  }

  async getMarkets() {
    if (Date.now() - this.lastFetch < REFRESH_MS) return this.cache;

    const results = await Promise.all(
      GEO_TAGS.map(tag =>
        axios.get(`${this.config.gammaHost}/markets`, {
          params: { active: true, closed: false, limit: 50, tag },
          timeout: 10000,
        }).then(r => r.data || []).catch(() => [])
      )
    );

    const seen = new Set();
    this.cache = results.flat().filter(m => {
      if (!m.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    this.lastFetch = Date.now();
    if (this.cache.length) {
      console.log(`[GeoScan] ${this.cache.length} geopolitics markets (0% fee)`);
    }
    return this.cache;
  }
}

module.exports = { GeopoliticsScanner };
