'use strict';

/**
 * Twitter/X signal source
 * Uses Twitter v2 API bearer token (free tier: search recent tweets)
 * Falls back gracefully if no token set
 */

const axios = require('axios');

const BULLISH_WORDS = ['yes', 'will', 'definitely', 'confirmed', 'sure', 'winning', 'leads',
  'ahead', 'likely', 'certain', 'expect', 'bullish', 'pumping'];
const BEARISH_WORDS = ['no', 'wont', "won't", 'never', 'unlikely', 'doubt', 'fails',
  'bearish', 'down', 'behind', 'trailing', 'impossible', 'reject'];

class TwitterSignal {
  constructor(config) {
    this.bearerToken = config.twitterBearerToken;
    this.available = !!this.bearerToken;
    this.cache = new Map();
    this.cacheTtl = 3 * 60 * 1000; // 3 min cache
    this.requestCount = 0;
    this.resetAt = Date.now() + 15 * 60 * 1000;
  }

  /** Search recent tweets for a query (max 10 results on free tier) */
  async searchTweets(query, maxResults = 10) {
    if (!this.available) return [];

    // Rate limit guard: ~15 req / 15min on free tier
    if (this.requestCount >= 12) {
      if (Date.now() < this.resetAt) return [];
      this.requestCount = 0;
      this.resetAt = Date.now() + 15 * 60 * 1000;
    }

    const cacheKey = query.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtl) return cached.tweets;

    try {
      const res = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
        params: {
          query: `${query} -is:retweet lang:en`,
          max_results: Math.max(10, Math.min(maxResults, 100)),
          'tweet.fields': 'created_at,public_metrics',
        },
        headers: { Authorization: `Bearer ${this.bearerToken}` },
        timeout: 8000,
      });

      this.requestCount++;
      const tweets = (res.data.data || []).map(t => ({
        text: t.text,
        likes: t.public_metrics?.like_count || 0,
        retweets: t.public_metrics?.retweet_count || 0,
        createdAt: t.created_at,
      }));

      this.cache.set(cacheKey, { tweets, ts: Date.now() });
      return tweets;
    } catch (err) {
      if (err.response?.status === 429) console.warn('[Twitter] Rate limited');
      return [];
    }
  }

  /** Score tweet sentiment weighted by engagement (likes + retweets) */
  async getSentiment(query) {
    const tweets = await this.searchTweets(query, 20);
    if (tweets.length === 0) return { score: 0.5, signal: 'NEUTRAL', count: 0, source: 'twitter' };

    let bullishWeight = 0;
    let bearishWeight = 0;

    for (const tweet of tweets) {
      const text = tweet.text.toLowerCase();
      const weight = 1 + Math.log1p(tweet.likes + tweet.retweets);
      const bullish = BULLISH_WORDS.filter(w => text.includes(w)).length;
      const bearish = BEARISH_WORDS.filter(w => text.includes(w)).length;
      bullishWeight += bullish * weight;
      bearishWeight += bearish * weight;
    }

    const total = bullishWeight + bearishWeight;
    if (total === 0) return { score: 0.5, signal: 'NEUTRAL', count: tweets.length, source: 'twitter' };

    const score = bullishWeight / total;
    const signal = score > 0.6 ? 'YES' : score < 0.4 ? 'NO' : 'NEUTRAL';

    return { score, signal, count: tweets.length, source: 'twitter' };
  }
}

module.exports = { TwitterSignal };
