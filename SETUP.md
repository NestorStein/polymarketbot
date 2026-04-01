# Polymarket Multi-Signal Bot — Setup Guide

## What This Bot Does

Three **fast strategies** (WebSocket-driven) + two **slow strategies** (signal-driven):

### Fast Strategies (documented profitable — one bot: $313 → $437,600)
1. **Oracle Lag Arb** — Binance spot price moves BEFORE Polymarket order book reprices. ~55s window. Trade when BTC/ETH moves >0.07% and the "winning" token is still below $0.62.
2. **Complement Arbitrage** — YES + NO < $1.00 = guaranteed profit. Detected in real-time via CLOB WebSocket (2.7s average window — faster than REST polling).
3. **Resolution Snipe** — Buy near-certain tokens ($0.85-$0.99) in the last 20 seconds before close.

### Slow Strategies (30s scan cycle)
4. **News Feed** (NewsAPI) — Detects breaking news matching market questions, scores sentiment
5. **Cross-Platform** — Compares Polymarket prices vs Kalshi + Manifold; divergence = signal

## Quick Start

### 1. Install dependencies
```
cd D:\polymarket-bot
npm install
```

### 2. Set up .env
Edit `.env` and fill in:

**Required:**
- `POLYGON_PRIVATE_KEY` — Private key of your Polygon wallet (not Solana!)
  - Create a new wallet at metamask.io or use `ethers.Wallet.createRandom()`
  - Fund it with USDC (Polygon USDC: `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`) + small MATIC (~0.1 MATIC for gas)

**Optional (enables more signals):**
- `TWITTER_BEARER_TOKEN` — Get free at developer.twitter.com (App-only auth)
- `NEWS_API_KEY` — Free at newsapi.org (100 req/day free)
- `KALSHI_EMAIL` + `KALSHI_PASSWORD` — Register at kalshi.com (free)

### 3. Run the bot
```
node index.js
```

### 4. Open dashboard
Navigate to: http://localhost:3002

## Strategy Config (.env)

| Variable | Default | Description |
|---|---|---|
| `MIN_ARB_PROFIT_PCT` | 0.015 | Min profit % for complement arb (1.5%) |
| `MIN_PRICE_GAP` | 0.04 | Min price gap for price-feed arb |
| `SENTIMENT_THRESHOLD` | 0.65 | Min signal confidence to trade |
| `MAX_POSITION_USDC` | 50 | Max $ per position |
| `RESERVE_USDC` | 10 | Keep this much USDC untouched |

## How Signals Work

### Signal Aggregation Weights
- Crypto price feed: **35%** (real-time, deterministic)
- Cross-platform (Kalshi/Manifold): **30%** (aggregated wisdom)
- News sentiment: **20%** (reliable but lagging)
- Twitter sentiment: **15%** (fast but noisy)

### Trade Decision
- Signals must agree on direction with confidence > `SENTIMENT_THRESHOLD`
- Won't buy YES above 82¢ or NO above 82¢ (too little upside)
- Kelly-inspired position sizing: more confident = bigger bet (up to MAX_POSITION_USDC)
- Max 5 concurrent open positions
- Never risk more than 30% of tradeable balance on one trade

## Complement Arbitrage Explained

If YES token costs 47¢ and NO token costs 50¢ = total 97¢
One of them MUST pay out 100¢ when the market resolves
Profit = 100¢ - 97¢ - ~2¢ fees = **1¢ guaranteed profit per dollar**

These windows open briefly when market makers are inactive or imbalanced.
The bot scans all active markets every 30 seconds looking for these.

## Dashboard Features
- Live crypto price bar (BTC, ETH, SOL, BNB, XRP, DOGE)
- P&L tracking, open positions, trade history
- Signal feed with confidence bars
- Arbitrage opportunity log
- Activity log with color-coded events
- Emergency stop button

## File Structure
```
polymarket-bot/
├── index.js              # Entry point + main loop
├── .env                  # Config (add your keys here)
├── src/
│   ├── config.js         # Config loader
│   ├── polymarket.js     # CLOB client wrapper
│   ├── strategyEngine.js # Orchestrates all strategies
│   ├── riskManager.js    # Position sizing + P&L tracking
│   ├── dashboard.js      # Socket.IO server
│   └── signals/
│       ├── signalAggregator.js  # Combines all signals
│       ├── newsFeed.js          # NewsAPI sentiment
│       ├── twitterSignal.js     # Twitter sentiment
│       ├── crossPlatform.js     # Kalshi + Manifold comparison
│       └── cryptoPriceFeed.js   # Binance WS + CoinGecko
└── public/
    └── index.html        # Dashboard UI
```
