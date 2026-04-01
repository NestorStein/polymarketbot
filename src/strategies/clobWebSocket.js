'use strict';

/**
 * Polymarket CLOB WebSocket Client
 * Real-time order book and price feed from:
 *   wss://ws-subscriptions-clob.polymarket.com/ws/
 *
 * Subscribes to price_change events on watched tokens.
 * Dramatically faster than polling the REST API for complement arb detection.
 * Window for complement arb dropped from 12s → 2.7s — need WebSocket to catch it.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

class ClobWebSocket extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.subscribedTokens = new Set();
    this.reconnectDelay = 1000;
    this.prices = new Map(); // tokenId → { best_bid, best_ask, ts }
    this._pingInterval = null;
  }

  connect() {
    this.ws = new WebSocket(CLOB_WS);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      console.log('[ClobWS] Connected to Polymarket CLOB WebSocket');

      // Resubscribe to all tokens
      if (this.subscribedTokens.size > 0) {
        this._subscribe([...this.subscribedTokens]);
      }

      // Keepalive ping every 20s
      this._pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on('message', (data) => {
      try {
        const events = JSON.parse(data);
        const arr = Array.isArray(events) ? events : [events];
        for (const evt of arr) {
          this._handleEvent(evt);
        }
      } catch { /* ignore */ }
    });

    this.ws.on('close', () => {
      this.connected = false;
      clearInterval(this._pingInterval);
      console.log('[ClobWS] Disconnected — reconnecting in', this.reconnectDelay, 'ms');
      setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.connect();
      }, this.reconnectDelay);
    });

    this.ws.on('error', err => {
      console.warn('[ClobWS] Error:', err.message);
    });
  }

  /** Subscribe to price changes for a list of token IDs */
  subscribeTokens(tokenIds) {
    for (const id of tokenIds) this.subscribedTokens.add(id);
    if (this.connected) {
      this._subscribe(tokenIds);
    }
  }

  _subscribe(tokenIds) {
    if (!tokenIds.length) return;
    const msg = JSON.stringify({
      auth: {},
      type: 'market',
      markets: [],
      assets_ids: tokenIds,
    });
    this.ws.send(msg);
  }

  _handleEvent(evt) {
    if (!evt.event_type) return;

    // price_change: best bid/ask updated for a token
    if (evt.event_type === 'price_change') {
      const tokenId = evt.asset_id;
      const bestBid = parseFloat(evt.best_bid || 0);
      const bestAsk = parseFloat(evt.best_ask || 1);

      const prev = this.prices.get(tokenId);
      this.prices.set(tokenId, { bestBid, bestAsk, ts: Date.now() });

      this.emit('price_change', { tokenId, bestBid, bestAsk, prev });
    }

    // book: full order book snapshot
    if (evt.event_type === 'book') {
      const tokenId = evt.asset_id;
      const bids = (evt.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
      const asks = (evt.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));

      const bestBid = bids.length > 0 ? Math.max(...bids.map(b => b.price)) : 0;
      const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => a.price)) : 1;

      this.prices.set(tokenId, { bestBid, bestAsk, bids, asks, ts: Date.now() });
      this.emit('book', { tokenId, bids, asks, bestBid, bestAsk });
    }
  }

  /** Get current best ask for a token */
  getBestAsk(tokenId) {
    return this.prices.get(tokenId)?.bestAsk ?? null;
  }

  /** Get current best bid for a token */
  getBestBid(tokenId) {
    return this.prices.get(tokenId)?.bestBid ?? null;
  }

  disconnect() {
    clearInterval(this._pingInterval);
    this.ws?.close();
  }
}

module.exports = { ClobWebSocket };
