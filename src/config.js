'use strict';

require('dotenv').config();

function loadConfig() {
  const pk = (process.env.POLYGON_PRIVATE_KEY || '').trim();
  if (!pk || pk === 'YOUR_POLYGON_PRIVATE_KEY_HERE') {
    throw new Error('POLYGON_PRIVATE_KEY not set in .env');
  }

  return {
    // Wallet
    polygonPrivateKey: pk,

    // Polymarket
    clobHost:  process.env.CLOB_HOST  || 'https://clob.polymarket.com',
    gammaHost: process.env.GAMMA_HOST || 'https://gamma-api.polymarket.com',
    chainId:   parseInt(process.env.CHAIN_ID || '137', 10),

    // AI
    anthropicApiKey:    process.env.ANTHROPIC_API_KEY || '',

    // External feeds
    twitterBearerToken: process.env.TWITTER_BEARER_TOKEN || '',
    newsApiKey:         process.env.NEWS_API_KEY || '',
    kalshiApiBase:      process.env.KALSHI_API_BASE || 'https://trading-api.kalshi.com/trade-api/v2',
    kalshiEmail:        process.env.KALSHI_EMAIL || '',
    kalshiPassword:     process.env.KALSHI_PASSWORD || '',
    coingeckoKey:       process.env.COINGECKO_API_KEY || '',
    manifoldApiBase:    process.env.MANIFOLD_API_BASE || 'https://api.manifold.markets/v0',

    // Strategy
    minArbProfitPct:    parseFloat(process.env.MIN_ARB_PROFIT_PCT   || '0.015'),
    minPriceGap:        parseFloat(process.env.MIN_PRICE_GAP        || '0.04'),
    sentimentThreshold: parseFloat(process.env.SENTIMENT_THRESHOLD  || '0.65'),
    maxPositionUsdc:    parseFloat(process.env.MAX_POSITION_USDC    || '50'),
    reserveUsdc:        parseFloat(process.env.RESERVE_USDC         || '5'),
    minEdgeMultiplier:  parseFloat(process.env.MIN_EDGE_MULTIPLIER  || '1.5'),
    maxDailyLossUsdc:   parseFloat(process.env.MAX_DAILY_LOSS_USDC  || '10'),
    maxDailyTrades:     parseInt  (process.env.MAX_DAILY_TRADES     || '3'),

    // Taker fee rates by market category (effective March 31, 2026)
    // 5-min Up/Down markets use crypto_fees_v2: 7.2% taker (oracle lag edge ~30-50¢, far exceeds fee)
    fees: {
      crypto:      { taker: 0.072, maker: 0 },  // 7.2% taker on 5-min Up/Down markets
      politics:    { taker: 0.010, maker: 0 },
      sports:      { taker: 0.0075, maker: 0 },
      geopolitics: { taker: 0.000, maker: 0 },  // fee-free!
      default:     { taker: 0.010, maker: 0 },
    },

    // Dashboard
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3002', 10),

    // Mode: only run oracle lag arb on 5-min Up/Down markets
    oracleLagOnly: process.env.ORACLE_LAG_ONLY === 'true',
  };
}

module.exports = { loadConfig };
