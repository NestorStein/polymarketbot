'use strict';

/**
 * Signal aggregator — combines news, Twitter, cross-platform, and crypto signals
 * into a single weighted prediction for each Polymarket market
 */

const { NewsFeed } = require('./newsFeed');
const { TwitterSignal } = require('./twitterSignal');
const { CrossPlatformSignal } = require('./crossPlatform');
const { CryptoPriceFeed } = require('./cryptoPriceFeed');

// Signal source weights
const WEIGHTS = {
  crypto_price:     0.35,  // Highest — deterministic, real-time
  cross_platform:   0.30,  // High — other prediction markets aggregated wisdom
  news:             0.20,  // Medium — lagging but reliable
  twitter:          0.15,  // Lower — noisy but fast-moving
};

class SignalAggregator {
  constructor(config) {
    this.config = config;
    this.news = new NewsFeed(config);
    this.twitter = new TwitterSignal(config);
    this.crossPlatform = new CrossPlatformSignal(config);
    this.priceFeed = new CryptoPriceFeed(config);
  }

  async start() {
    await this.priceFeed.start();
    console.log('[Signals] All signal sources initialized');
  }

  /**
   * Aggregate all signals for a market.
   * Returns { recommendation: 'BUY_YES'|'BUY_NO'|'SKIP', confidence, signals, reasoning }
   */
  async analyzeMarket(market) {
    const question = market.question || market.title || '';
    if (!question) return { recommendation: 'SKIP', confidence: 0, signals: [], reasoning: 'No question' };

    const keywords = NewsFeed.extractKeywords(question);
    const currentYesPrice = this._getYesPrice(market);

    // Run fast signals first (no API quota cost)
    const [crossResult, cryptoResult] = await Promise.all([
      this.crossPlatform.getCrossPlatformSignal(keywords, currentYesPrice).catch(() => ({ signal: 'NEUTRAL', confidence: 0, sources: [] })),
      Promise.resolve(this.priceFeed.getSignalForMarket(question)),
    ]);

    // Only fetch news/twitter if we already have at least one fast signal
    // This preserves the 100 req/day NewsAPI quota
    const hasFastSignal = crossResult.signal !== 'NEUTRAL' || (cryptoResult && cryptoResult.signal !== 'NEUTRAL');
    const [newsResult, twitterResult] = hasFastSignal
      ? await Promise.all([
          this.news.getSentiment(keywords).catch(() => ({ signal: 'NEUTRAL', score: 0.5, source: 'news' })),
          this.twitter.getSentiment(keywords).catch(() => ({ signal: 'NEUTRAL', score: 0.5, source: 'twitter' })),
        ])
      : [
          { signal: 'NEUTRAL', score: 0.5, source: 'news' },
          { signal: 'NEUTRAL', score: 0.5, source: 'twitter' },
        ];

    const signals = [];

    // News
    if (newsResult.signal !== 'NEUTRAL') {
      signals.push({
        source: 'news',
        signal: newsResult.signal,
        weight: WEIGHTS.news,
        score: newsResult.score,
        detail: `${newsResult.articles?.length || 0} articles`,
      });
    }

    // Twitter
    if (twitterResult.signal !== 'NEUTRAL') {
      signals.push({
        source: 'twitter',
        signal: twitterResult.signal,
        weight: WEIGHTS.twitter,
        score: twitterResult.score,
        detail: `${twitterResult.count || 0} tweets`,
      });
    }

    // Cross-platform
    if (crossResult.signal !== 'NEUTRAL') {
      signals.push({
        source: 'cross_platform',
        signal: crossResult.signal,
        weight: WEIGHTS.cross_platform * crossResult.confidence,
        score: crossResult.confidence,
        detail: crossResult.sources.map(s => `${s.platform}:${(s.price * 100).toFixed(0)}%`).join(' '),
      });
    }

    // Crypto price
    if (cryptoResult && cryptoResult.signal !== 'NEUTRAL') {
      signals.push({
        source: 'crypto_price',
        signal: cryptoResult.signal,
        weight: WEIGHTS.crypto_price * cryptoResult.confidence,
        score: cryptoResult.confidence,
        detail: `${cryptoResult.symbol} ${cryptoResult.change24h > 0 ? '+' : ''}${cryptoResult.change24h?.toFixed(1)}%`,
      });
    }

    if (signals.length === 0) {
      return { recommendation: 'SKIP', confidence: 0, signals: [], reasoning: 'No clear signals' };
    }

    // Require at least 2 independent signal sources to trade
    if (signals.length < 2) {
      return { recommendation: 'SKIP', confidence: 0, signals, reasoning: `Only 1 signal source (need 2+)` };
    }

    // Weighted vote
    let yesWeight = 0;
    let noWeight = 0;

    for (const s of signals) {
      if (s.signal === 'YES') yesWeight += s.weight;
      else if (s.signal === 'NO') noWeight += s.weight;
    }

    const totalWeight = yesWeight + noWeight;
    const confidence = Math.abs(yesWeight - noWeight) / totalWeight;

    if (confidence < 0.30) {
      return { recommendation: 'SKIP', confidence, signals, reasoning: 'Signals conflicting' };
    }

    const winningSignal = yesWeight > noWeight ? 'YES' : 'NO';
    const recommendation = `BUY_${winningSignal}`;

    // Price sanity check — don't buy YES at >0.85 or NO at >0.85 (low upside)
    if (winningSignal === 'YES' && currentYesPrice > 0.82) {
      return { recommendation: 'SKIP', confidence, signals, reasoning: 'YES price too high (>82¢)' };
    }
    if (winningSignal === 'NO' && (1 - currentYesPrice) > 0.82) {
      return { recommendation: 'SKIP', confidence, signals, reasoning: 'NO price too high (>82¢)' };
    }

    const reasoning = signals
      .map(s => `${s.source}=${s.signal}(${(s.score * 100).toFixed(0)}%)`)
      .join(', ');

    return { recommendation, confidence, signals, reasoning, yesWeight, noWeight };
  }

  _getYesPrice(market) {
    let prices = market.outcomePrices || [];
    if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = []; } }
    return parseFloat(prices[0]) || 0.5;
  }

  stop() {
    this.priceFeed.stop();
  }
}

module.exports = { SignalAggregator };
