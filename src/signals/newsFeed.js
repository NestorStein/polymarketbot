'use strict';

/**
 * News feed signal source
 * Uses NewsAPI.org to detect breaking news relevant to open markets
 */

const axios = require('axios');

// Simple keyword sentiment scoring
const BULLISH_WORDS = ['win', 'wins', 'victory', 'confirmed', 'yes', 'approved', 'passed', 'elected',
  'positive', 'success', 'achieved', 'signed', 'launched', 'beat', 'ahead', 'leading', 'surpassed'];
const BEARISH_WORDS = ['lose', 'lost', 'defeat', 'rejected', 'no', 'denied', 'failed', 'dropped',
  'negative', 'blocked', 'cancelled', 'behind', 'trailing', 'collapsed', 'fell', 'down'];

class NewsFeed {
  constructor(config) {
    this.apiKey = config.newsApiKey;
    this.cache = new Map(); // keyword → {articles, ts}
    this.cacheTtl = 60 * 60 * 1000; // 60 min cache (free tier = 100 req/day)
    this.available = !!this.apiKey;
    this.dailyRequests = 0;
    this.dailyLimit = 80; // stay under 100/day limit
    this.dayReset = Date.now() + 24 * 60 * 60 * 1000;
  }

  /** Fetch recent news for a query keyword */
  async fetchNews(query, maxResults = 10) {
    if (!this.available) return [];

    // Reset daily counter
    if (Date.now() > this.dayReset) {
      this.dailyRequests = 0;
      this.dayReset = Date.now() + 24 * 60 * 60 * 1000;
    }

    const cacheKey = query.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtl) {
      return cached.articles;
    }

    // Hard limit — stop before hitting free tier ceiling
    if (this.dailyRequests >= this.dailyLimit) return [];
    this.dailyRequests++;

    try {
      const res = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          sortBy: 'publishedAt',
          pageSize: maxResults,
          language: 'en',
          apiKey: this.apiKey,
        },
        timeout: 8000,
      });

      const articles = (res.data.articles || []).map(a => ({
        title: a.title || '',
        description: a.description || '',
        publishedAt: a.publishedAt,
        source: a.source?.name || '',
        url: a.url,
      }));

      this.cache.set(cacheKey, { articles, ts: Date.now() });
      return articles;
    } catch (err) {
      if (err.response?.status === 429) {
        // Silence repeated rate limit warnings — set high limit to stop retrying today
        this.dailyRequests = this.dailyLimit;
      }
      return [];
    }
  }

  /** Score news sentiment for a query. Returns { score: 0-1, signal: 'YES'|'NO'|'NEUTRAL', articles } */
  async getSentiment(query) {
    const articles = await this.fetchNews(query, 20);
    if (articles.length === 0) return { score: 0.5, signal: 'NEUTRAL', articles: [], source: 'news' };

    let bullishCount = 0;
    let bearishCount = 0;

    for (const article of articles) {
      const text = (article.title + ' ' + article.description).toLowerCase();
      const bullish = BULLISH_WORDS.filter(w => text.includes(w)).length;
      const bearish = BEARISH_WORDS.filter(w => text.includes(w)).length;
      bullishCount += bullish;
      bearishCount += bearish;
    }

    const total = bullishCount + bearishCount;
    if (total === 0) return { score: 0.5, signal: 'NEUTRAL', articles: articles.slice(0, 3), source: 'news' };

    const score = bullishCount / total;
    const signal = score > 0.6 ? 'YES' : score < 0.4 ? 'NO' : 'NEUTRAL';

    return { score, signal, articles: articles.slice(0, 3), source: 'news' };
  }

  /** Extract search keywords from a market question */
  static extractKeywords(question) {
    // Remove common filler words
    const stop = new Set(['will', 'the', 'a', 'an', 'be', 'in', 'on', 'at', 'by', 'of', 'or',
      'and', 'to', 'for', 'is', 'are', 'was', 'were', 'this', 'that', 'with', 'from']);
    const words = question
      .replace(/[?.,!]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stop.has(w.toLowerCase()));
    return words.slice(0, 4).join(' ');
  }
}

module.exports = { NewsFeed };
