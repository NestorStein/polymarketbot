'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const EventEmitter = require('events');
const axios    = require('axios');
const ethers   = require('ethers');

const CTF_ADDRESS  = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E       = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ZERO_B32     = '0x' + '0'.repeat(64);
const CTF_IFACE    = new ethers.utils.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
]);
const POLY_RPCS = [
  'https://polygon-rpc.com',
  'https://polygon.drpc.org',
  'https://polygon-bor-rpc.publicnode.com',
];

class Dashboard extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.app    = express();
    this.server = http.createServer(this.app);
    this.io     = new Server(this.server);

    this.state = {
      wallet:           '',
      balance:          0,
      startBalance:     0,
      realizedPnl:      0,
      openPositions:    0,
      totalInvested:    0,
      scanCount:        0,
      opportunitiesFound: 0,
      tradesExecuted:   0,
      winCount:         0,
      lossCount:        0,
      status:           'STARTING',
      lastSignals:      [],
      recentTrades:     [],
      positions:        [],
      cryptoPrices:     {},
      arbHistory:       [],
      log:              [],
    };

    this._setupRoutes();
    this._setupSockets();
  }

  _setupRoutes() {
    this.app.use(express.static(path.join(__dirname, '..', 'public')));
    this.app.use(express.json());
    this.app.get('/api/state', (req, res) => res.json(this.state));

    // Proxy Polymarket data API for positions
    this.app.get('/api/positions', async (req, res) => {
      try {
        const wallet = this.state.wallet;
        if (!wallet) return res.json([]);
        const url = `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=.01&sortBy=CURRENT`;
        const resp = await axios.get(url, { timeout: 8000 });
        res.json(resp.data || []);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Redeem a winning position on-chain
    this.app.post('/api/redeem', async (req, res) => {
      try {
        const { conditionId, outcomeIndex } = req.body;
        if (!conditionId || outcomeIndex === undefined) {
          return res.status(400).json({ error: 'conditionId and outcomeIndex required' });
        }
        const txHash = await this._redeemOnChain(conditionId, parseInt(outcomeIndex));
        res.json({ success: true, txHash });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  async _redeemOnChain(conditionId, outcomeIndex) {
    const indexSet = outcomeIndex === 0 ? 1 : 2;
    const data = CTF_IFACE.encodeFunctionData('redeemPositions', [USDC_E, ZERO_B32, conditionId, [indexSet]]);
    const wallet = new ethers.Wallet(this.config.polygonPrivateKey);
    const provider = new ethers.providers.JsonRpcProvider(POLY_RPCS[0]);
    const nonce = await provider.getTransactionCount(wallet.address);
    const tx = {
      to: CTF_ADDRESS,
      data,
      gasLimit: 200000,
      gasPrice: ethers.utils.parseUnits('300', 'gwei'),
      nonce,
      chainId: 137,
    };
    const signedTx = await wallet.signTransaction(tx);
    const results = await Promise.allSettled(
      POLY_RPCS.map(rpc => axios.post(rpc,
        { jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [signedTx], id: 1 },
        { timeout: 10000 }
      ))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.data?.result) {
        console.log(`[Dashboard] Redeem tx: ${r.value.data.result}`);
        return r.value.data.result;
      }
    }
    const firstErr = results.find(r => r.status === 'rejected' || r.value?.data?.error);
    const msg = firstErr?.reason?.message || JSON.stringify(firstErr?.value?.data?.error) || 'All RPCs failed';
    throw new Error(msg);
  }

  _setupSockets() {
    this.io.on('connection', (socket) => {
      socket.emit('state', this.state);

      socket.on('emergency_stop', () => {
        this._log('EMERGENCY STOP triggered from dashboard', 'error');
        this.emit('emergency_stop');
      });

      socket.on('request_state', () => {
        socket.emit('state', this.state);
      });
    });
  }

  _log(msg, level = 'info') {
    const entry = { msg, level, ts: Date.now(), time: new Date().toLocaleTimeString() };
    this.state.log.unshift(entry);
    if (this.state.log.length > 100) this.state.log = this.state.log.slice(0, 100);
    this.io.emit('log', entry);
  }

  _broadcast() {
    this.io.emit('state', this.state);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  botStart({ wallet, balance }) {
    this.state.wallet = wallet;
    this.state.balance = balance;
    this.state.startBalance = balance;
    this.state.status = 'SCANNING';
    this._log(`Bot started. Wallet: ${wallet.slice(0, 8)}... Balance: $${balance.toFixed(2)} USDC`);
    this._broadcast();
  }

  balanceUpdate(balance, stats) {
    this.state.balance         = balance;
    this.state.realizedPnl     = stats.realizedPnl;
    this.state.openPositions   = stats.openPositions;
    this.state.totalInvested   = stats.totalInvested;
    this.state.winCount        = stats.winCount;
    this.state.lossCount       = stats.lossCount;
    this.state.positions       = stats.positions;
    this.state.recentTrades    = stats.recentTrades;
    this._broadcast();
  }

  arbFound(arb) {
    const entry = {
      ts: Date.now(),
      time: new Date().toLocaleTimeString(),
      market: arb.market?.slice(0, 60),
      yesAsk: arb.yesAsk,
      noAsk: arb.noAsk,
      profitPct: arb.profitPct,
    };
    this.state.arbHistory.unshift(entry);
    if (this.state.arbHistory.length > 50) this.state.arbHistory = this.state.arbHistory.slice(0, 50);
    this.state.opportunitiesFound++;
    this._log(`ARB: ${entry.market} | profit ${(arb.profitPct * 100).toFixed(2)}%`, 'success');
    this.io.emit('arb_found', entry);
    this._broadcast();
  }

  signalFound({ market, recommendation, confidence, reasoning }) {
    const entry = {
      ts: Date.now(),
      time: new Date().toLocaleTimeString(),
      market: market?.slice(0, 60),
      recommendation,
      confidence,
      reasoning,
    };
    this.state.lastSignals.unshift(entry);
    if (this.state.lastSignals.length > 20) this.state.lastSignals = this.state.lastSignals.slice(0, 20);
    this.io.emit('signal', entry);
  }

  tradeExecuted(trade) {
    this.state.tradesExecuted++;
    this._log(`TRADE: ${trade.type} ${trade.side || ''} $${trade.size?.toFixed(2) || trade.sizePerSide?.toFixed(2)} | ${(trade.market || trade.market)?.slice(0, 40)}`, 'trade');
    this.io.emit('trade', trade);
    this._broadcast();
  }

  cryptoPriceUpdate(prices) {
    this.state.cryptoPrices = prices;
    this.io.emit('prices', prices);
  }

  scanUpdate(scanCount) {
    this.state.scanCount = scanCount;
    this._broadcast();
  }

  stopped() {
    this.state.status = 'STOPPED';
    this._log('Bot stopped', 'warn');
    this._broadcast();
  }

  // ── Server ──────────────────────────────────────────────────────────────────

  listen() {
    return new Promise((resolve) => {
      this.server.listen(this.config.dashboardPort, () => {
        console.log(`[Dashboard] http://localhost:${this.config.dashboardPort}`);
        resolve();
      });
    });
  }
}

module.exports = { Dashboard };
