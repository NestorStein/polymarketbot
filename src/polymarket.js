'use strict';

/**
 * Polymarket CLOB client wrapper
 * Handles auth, market discovery, order book fetching, and order placement
 */

const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const { ethers } = require('ethers');
const axios = require('axios');

class PolymarketClient {
  constructor(config) {
    this.config = config;
    this.wallet = new ethers.Wallet(config.polygonPrivateKey);
    this.client = null;
    this.apiKey = null;
    this.ready = false;
  }

  async init() {
    try {
      // L1 auth — derive API keys from wallet signature
      this.client = new ClobClient(
        this.config.clobHost,
        this.config.chainId,
        this.wallet,
      );

      // Create/fetch API key (L2 auth)
      this.apiKey = await this.client.createOrDeriveApiKey();
      this.client = new ClobClient(
        this.config.clobHost,
        this.config.chainId,
        this.wallet,
        this.apiKey,
      );

      this.ready = true;
      return true;
    } catch (err) {
      console.error('[Polymarket] Init failed:', err.message);
      return false;
    }
  }

  /** Fetch active markets from Gamma API sorted by 24h volume (highest liquidity first) */
  async getActiveMarkets(limit = 50) {
    try {
      const res = await axios.get(`${this.config.gammaHost}/markets`, {
        params: { active: true, closed: false, limit, order: 'volume24hr', ascending: false },
        timeout: 10000,
      });
      return res.data || [];
    } catch (err) {
      console.error('[Polymarket] getActiveMarkets error:', err.message);
      return [];
    }
  }

  /** Get order book for a token (YES or NO side) */
  async getOrderBook(tokenId) {
    try {
      const book = await this.client.getOrderBook(tokenId);
      return book;
    } catch (err) {
      return null;
    }
  }

  /** Get best ask (lowest sell price) for a token */
  getBestAsk(orderBook) {
    if (!orderBook || !orderBook.asks || orderBook.asks.length === 0) return null;
    return Math.min(...orderBook.asks.map(a => parseFloat(a.price)));
  }

  /** Get best bid (highest buy price) for a token */
  getBestBid(orderBook) {
    if (!orderBook || !orderBook.bids || orderBook.bids.length === 0) return null;
    return Math.max(...orderBook.bids.map(b => parseFloat(b.price)));
  }

  /** Categorize a market by type for fee calculation */
  static categorizeMarket(market) {
    const q = (market.question || market.title || '').toLowerCase();
    const tags = (market.tags || []).map(t => (typeof t === 'object' ? t.id || t.label || '' : t).toLowerCase());

    if (tags.some(t => ['crypto', 'cryptocurrency'].includes(t)) ||
        q.includes('bitcoin') || q.includes('ethereum') || q.includes(' btc') ||
        q.includes(' eth ') || q.includes('solana') || q.includes(' sol ') ||
        q.includes('up or down') || q.includes('crypto')) return 'crypto';

    if (tags.some(t => ['geopolitics', 'international', 'foreign-policy', 'war', 'diplomacy'].includes(t)) ||
        q.includes('treaty') || q.includes('sanction') || q.includes('nato') ||
        q.includes('ceasefire') || q.includes('invasion') || q.includes('missile')) return 'geopolitics';

    if (tags.some(t => ['politics', 'election', 'government'].includes(t)) ||
        q.includes('president') || q.includes('congress') || q.includes('senate') ||
        q.includes('governor') || q.includes('election') || q.includes('vote')) return 'politics';

    if (tags.some(t => ['sports', 'nba', 'nfl', 'mlb', 'nhl', 'soccer'].includes(t)) ||
        q.includes(' nba') || q.includes(' nfl') || q.includes(' mlb') ||
        q.includes('championship') || q.includes('super bowl') || q.includes('world cup')) return 'sports';

    return 'default';
  }

  /** Parse clobTokenIds from market (JSON string or array) */
  static parseTokenIds(market) {
    let ids = market.clobTokenIds || market.tokens;
    if (!ids) return [];
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { return []; }
    }
    // If array of objects, extract token_id
    return ids.map(t => (typeof t === 'object' ? t.token_id : t)).filter(Boolean);
  }

  /**
   * Scan for complement arbitrage:
   * If YES_ask + NO_ask < 1.00 - fee_buffer → guaranteed profit
   */
  async findComplementArb(market) {
    try {
      const tokenIds = PolymarketClient.parseTokenIds(market);
      if (tokenIds.length < 2) return null;

      const yesTokenId = tokenIds[0];
      const noTokenId  = tokenIds[1];
      if (!yesTokenId || !noTokenId) return null;

      const [yesBook, noBook] = await Promise.all([
        this.getOrderBook(yesTokenId),
        this.getOrderBook(noTokenId),
      ]);

      const yesAsk = this.getBestAsk(yesBook);
      const noAsk  = this.getBestAsk(noBook);
      if (yesAsk === null || noAsk === null) return null;

      const totalCost = yesAsk + noAsk;
      const category  = PolymarketClient.categorizeMarket(market);
      const feeRate   = this.config.fees?.[category]?.taker ?? 0.01;
      const feeBuffer = feeRate * 2; // both sides pay taker fee
      const minProfit = (this.config.minEdgeMultiplier ?? 1.5) * feeBuffer;
      const profit    = 1.0 - totalCost - feeBuffer;

      if (profit > minProfit) {
        return {
          type: 'COMPLEMENT_ARB',
          market: market.question || market.title,
          marketId: market.id,
          yesTokenId,
          noTokenId,
          yesAsk,
          noAsk,
          totalCost,
          profitPct: profit,
          profitUsd: profit * this.config.maxPositionUsdc,
          negRisk: !!market.negRisk,
        };
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  /** Get current USDC.e balance — uses CLOB API (reliable) with on-chain fallback */
  async getBalance() {
    // Primary: CLOB API knows exactly what's available to trade
    if (this.ready && this.client) {
      try {
        const data = await this.client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
        if (data?.balance) return parseInt(data.balance) / 1e6;
      } catch { /* fall through to on-chain */ }
    }
    // Fallback: direct RPC call with multiple providers
    const rpcs = ['https://polygon.drpc.org', 'https://polygon.llamarpc.com'];
    const USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
    const addr = this.wallet.address;
    const calldata = '0x70a08231' + '000000000000000000000000' + addr.slice(2).toLowerCase();
    for (const rpc of rpcs) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        const raw = await provider.call({ to: USDC_E, data: calldata }, 'latest');
        return parseInt(raw, 16) / 1e6;
      } catch { /* try next */ }
    }
    return 0;
  }

  /** Check native USDC balance (needs swap to USDC.e before trading) */
  async getNativeUsdcBalance() {
    const USDC_N = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
    const addr = this.wallet.address;
    const calldata = '0x70a08231' + '000000000000000000000000' + addr.slice(2).toLowerCase();
    const rpcs = ['https://polygon.drpc.org', 'https://polygon.llamarpc.com'];
    for (const rpc of rpcs) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        const raw = await provider.call({ to: USDC_N, data: calldata }, 'latest');
        return parseInt(raw, 16) / 1e6;
      } catch { /* try next */ }
    }
    return 0;
  }

  /** Place a limit buy order */
  async placeBuyOrder(tokenId, price, sizeUsdc, tickSize = 0.01, negRisk = false) {
    if (!this.ready) throw new Error('Client not initialized');

    const size = Math.floor(sizeUsdc / price); // shares to buy — must be whole number for FOK
    const orderArgs = { tokenID: tokenId, price, side: Side.BUY, size };
    // Pass negRisk explicitly so order is signed against the correct exchange contract
    const marketInfo = { tickSize, negRisk: !!negRisk };

    const resp = await this.client.createAndPostOrder(orderArgs, marketInfo, OrderType.FOK);
    return resp;
  }

  /** Cancel all open orders */
  async cancelAll() {
    try {
      await this.client.cancelAll();
    } catch { /* ignore */ }
  }

  /** Get open orders */
  async getOpenOrders() {
    try {
      const orders = await this.client.getOpenOrders({});
      return orders || [];
    } catch {
      return [];
    }
  }

  /** Fetch single market by condition ID */
  async getMarket(conditionId) {
    try {
      const res = await axios.get(`${this.config.gammaHost}/markets/${conditionId}`, {
        timeout: 5000,
      });
      return res.data;
    } catch {
      return null;
    }
  }
}

module.exports = { PolymarketClient };
