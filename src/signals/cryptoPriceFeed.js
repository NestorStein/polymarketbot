'use strict';

/**
 * Crypto price feed signal
 * Uses CoinGecko (free) + Binance WebSocket for real-time prices
 * Maps price movements to Polymarket crypto market predictions
 */

const axios = require('axios');
const WebSocket = require('ws');
const EventEmitter = require('events');

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  MATIC: 'matic-network',
};

class CryptoPriceFeed extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.prices = {};      // symbol → { price, change24h, changeDirection }
    this.ws = null;
    this.wsReady = false;
    this.symbols = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'dogeusdt'];
  }

  /** Connect to Binance WebSocket for real-time ticker data */
  connectBinance() {
    const streams = this.symbols.map(s => `${s}@miniTicker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.wsReady = true;
      console.log('[PriceFeed] Binance WS connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const ticker = msg.data;
        if (!ticker) return;

        const symbol = ticker.s.replace('USDT', ''); // BTCUSDT → BTC
        const price = parseFloat(ticker.c);
        const open  = parseFloat(ticker.o);
        const change24h = ((price - open) / open) * 100;

        this.prices[symbol] = {
          price,
          change24h,
          changeDirection: change24h > 0 ? 'UP' : 'DOWN',
          ts: Date.now(),
        };

        this.emit('price', { symbol, price, change24h });
      } catch { /* ignore */ }
    });

    this.ws.on('error', (err) => {
      console.warn('[PriceFeed] WS error:', err.message);
    });

    this.ws.on('close', () => {
      this.wsReady = false;
      // Reconnect after 5s
      setTimeout(() => this.connectBinance(), 5000);
    });
  }

  /** Fetch snapshot prices from CoinGecko (fallback / initial load) */
  async fetchCoinGecko() {
    try {
      const ids = Object.values(COINGECKO_IDS).join(',');
      const url = this.config.coingeckoKey
        ? `https://pro-api.coingecko.com/api/v3/simple/price`
        : `https://api.coingecko.com/api/v3/simple/price`;

      const res = await axios.get(url, {
        params: {
          ids,
          vs_currencies: 'usd',
          include_24hr_change: true,
          ...(this.config.coingeckoKey ? { x_cg_pro_api_key: this.config.coingeckoKey } : {}),
        },
        timeout: 10000,
      });

      for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
        const data = res.data[geckoId];
        if (data) {
          this.prices[symbol] = {
            price: data.usd,
            change24h: data.usd_24h_change || 0,
            changeDirection: (data.usd_24h_change || 0) > 0 ? 'UP' : 'DOWN',
            ts: Date.now(),
          };
        }
      }
    } catch (err) {
      console.warn('[PriceFeed] CoinGecko error:', err.message);
    }
  }

  /** Start price feeds */
  async start() {
    await this.fetchCoinGecko();
    this.connectBinance();
    // Refresh CoinGecko every 60s as backup
    setInterval(() => this.fetchCoinGecko(), 60000);
  }

  /** Get signal for a crypto-related market question */
  getSignalForMarket(question) {
    const q = question.toUpperCase();
    let symbol = null;

    for (const sym of Object.keys(COINGECKO_IDS)) {
      if (q.includes(sym)) { symbol = sym; break; }
    }
    if (!symbol) return null;

    const data = this.prices[symbol];
    if (!data) return null;

    // Generate signal based on price action
    let signal = 'NEUTRAL';
    let confidence = 0;

    // Strong move signals
    if (data.change24h > 5) { signal = 'YES'; confidence = 0.7; }
    else if (data.change24h > 2) { signal = 'YES'; confidence = 0.55; }
    else if (data.change24h < -5) { signal = 'NO'; confidence = 0.7; }
    else if (data.change24h < -2) { signal = 'NO'; confidence = 0.55; }

    // Context: "will X be above Y?" — if price already above target, YES
    const aboveMatch = question.match(/above\s+\$?([\d,]+)/i);
    if (aboveMatch) {
      const target = parseFloat(aboveMatch[1].replace(',', ''));
      if (data.price > target * 1.02) { signal = 'YES'; confidence = 0.85; }
      else if (data.price < target * 0.98) { signal = 'NO'; confidence = 0.85; }
    }

    return {
      signal,
      confidence,
      symbol,
      price: data.price,
      change24h: data.change24h,
      source: 'crypto_price',
    };
  }

  getCurrentPrices() {
    return { ...this.prices };
  }

  stop() {
    if (this.ws) this.ws.close();
  }
}

module.exports = { CryptoPriceFeed };
