'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
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
    this._polyClient = null; // set by engine after init

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

    // PM2 bot control — stop / start via dashboard button
    // Pause / resume trading (keeps dashboard alive)
    this.app.post('/api/bot/pause', (req, res) => {
      this.emit('bot_pause');
      this.state.status = 'PAUSED';
      this._broadcast();
      res.json({ success: true, status: 'PAUSED' });
    });

    this.app.post('/api/bot/resume', (req, res) => {
      this.emit('bot_resume');
      this.state.status = 'SCANNING';
      this._broadcast();
      res.json({ success: true, status: 'SCANNING' });
    });

    this.app.get('/api/bot/status', (req, res) => {
      res.json({ status: this.state.status || 'SCANNING' });
    });

    // Real-time USDC balance from CLOB API
    this.app.get('/api/balance', async (req, res) => {
      try {
        if (!this._polyClient) return res.json({ balance: this.state.balance });
        const balance = await this._polyClient.getBalance();
        this.state.balance = balance; // keep state in sync
        res.json({ balance });
      } catch (err) {
        res.json({ balance: this.state.balance });
      }
    });

    // Resolve bet result by market slug — returns { winner: 'UP'|'DOWN', closed: bool }
    this.app.get('/api/market-result', async (req, res) => {
      try {
        const { slug } = req.query;
        if (!slug) return res.status(400).json({ error: 'slug required' });
        const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
        const resp = await axios.get(url, { timeout: 6000 });
        const events = resp.data;
        const ev = Array.isArray(events) ? events[0] : events;
        if (!ev) return res.json({ closed: false });
        const mkt = (ev.markets || [])[0];
        if (!mkt) return res.json({ closed: ev.closed || false });
        let prices = mkt.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
        let winner = null;
        if (Array.isArray(prices)) {
          // index 0 = UP/YES token, index 1 = DOWN/NO token
          if (parseFloat(prices[0]) >= 0.99) winner = 'UP';
          else if (parseFloat(prices[1]) >= 0.99) winner = 'DOWN';
        }
        res.json({ closed: ev.closed || mkt.closed || false, winner });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Full report data — activity + positions processed into trades, daily PNL, balance history
    this.app.get('/api/report-data', async (req, res) => {
      try {
        const wallet = this.state.wallet;
        if (!wallet) return res.json({ error: 'Wallet not ready' });

        const [actResp, posResp] = await Promise.all([
          axios.get(`https://data-api.polymarket.com/activity?user=${wallet}&limit=500`, { timeout: 15000 }),
          axios.get(`https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=.01&sortBy=CURRENT`, { timeout: 8000 }),
        ]);
        const activity = actResp.data || [];
        const positions = posResp.data || [];

        // Group activity by market title → match buys to redeems
        const byMarket = {};
        for (const act of activity) {
          if (!act.title || act.type === 'YIELD') continue;
          if (!byMarket[act.title]) byMarket[act.title] = { buys: [], sells: [], redeems: [], title: act.title };
          if (act.type === 'TRADE' && act.side === 'BUY')  byMarket[act.title].buys.push(act);
          if (act.type === 'TRADE' && act.side === 'SELL') byMarket[act.title].sells.push(act);
          if (act.type === 'REDEEM')                        byMarket[act.title].redeems.push(act);
        }

        // Positions lookup by title for hybrid PNL (positions API has accurate cost basis)
        const posMap = {};
        for (const pos of positions) posMap[(pos.title || '').toLowerCase()] = pos;

        // Build per-trade objects using hybrid PNL approach
        const trades = [];
        for (const [title, m] of Object.entries(byMarket)) {
          if (!m.buys.length) continue;
          const hasRedeems = m.redeems.length > 0;
          const hasSells   = m.sells.length > 0;
          const posData    = posMap[title.toLowerCase()];

          let cost, received, pnl, result;

          if (hasRedeems) {
            // Activity-based: won markets settled via REDEEM activity
            const totalBought   = m.buys.reduce((s, a)   => s + (parseFloat(a.usdcSize) || 0), 0);
            const totalSold     = m.sells.reduce((s, a)  => s + (parseFloat(a.usdcSize) || 0), 0);
            const totalRedeemed = m.redeems.reduce((s,a) => s + (parseFloat(a.usdcSize) || 0), 0);
            cost     = totalBought - totalSold;
            received = totalRedeemed;
            pnl      = Math.round((received - cost) * 100) / 100;
            result   = pnl >= 0 ? 'WIN' : 'LOSS';
          } else if (posData && !hasSells && parseFloat(posData.curPrice ?? 1) < 0.01) {
            // Positions API path: market settled to 0 (settled loss), no redemption in activity
            // Use initialValue as true cost basis (more accurate than activity usdcSize)
            cost     = Math.round((parseFloat(posData.initialValue) || 0) * 100) / 100;
            pnl      = Math.round((parseFloat(posData.cashPnl)      || 0) * 100) / 100;
            received = Math.round((cost + pnl) * 100) / 100;  // derived: cost + cashPnl
            result   = pnl >= 0 ? 'WIN' : 'LOSS';
          } else if (hasSells) {
            // Activity-based sell-back (no redemption)
            const totalBought = m.buys.reduce((s, a)  => s + (parseFloat(a.usdcSize) || 0), 0);
            const totalSold   = m.sells.reduce((s, a) => s + (parseFloat(a.usdcSize) || 0), 0);
            cost     = totalBought;
            received = totalSold;
            pnl      = Math.round((received - cost) * 100) / 100;
            result   = pnl >= 0 ? 'WIN' : 'LOSS';
          } else {
            // Still open
            const totalBought = m.buys.reduce((s, a) => s + (parseFloat(a.usdcSize) || 0), 0);
            cost     = Math.round(totalBought * 100) / 100;
            received = 0;
            pnl      = 0;
            result   = 'OPEN';
          }

          // Asset detection
          let asset = 'OTHER';
          if (title.includes('Bitcoin'))       asset = 'BTC';
          else if (title.includes('Ethereum')) asset = 'ETH';
          else if (title.includes('Solana'))   asset = 'SOL';
          else if (title.includes('XRP'))      asset = 'XRP';
          else if (title.includes('Dogecoin')) asset = 'DOGE';
          else if (title.includes('BNB'))      asset = 'BNB';

          const entryTs    = Math.min(...m.buys.map(b => b.timestamp)) * 1000;
          const isOracleLagTitle = title.includes('Up or Down');
          const sellTs     = m.sells.length ? Math.max(...m.sells.map(s => s.timestamp)) * 1000 : null;
          // For 5-min oracle lag markets the market resolves ~5min after entry.
          // REDEEM txs fire hours/days later and must NOT be used as exit time.
          // Sell-backs are immediate exits so they keep their actual timestamp.
          const exitTs = result === 'OPEN'   ? null
                       : hasSells            ? sellTs               // sold out — actual exit
                       : isOracleLagTitle    ? entryTs + 300000     // 5-min market: resolved at entry+5m
                       : m.redeems.length    ? Math.max(...m.redeems.map(r => r.timestamp)) * 1000
                       : entryTs + 300000;
          const holdSecs = exitTs ? Math.round((exitTs - entryTs) / 1000) : null;
          const avgEntry = m.buys[0] ? parseFloat(m.buys[0].price) || 0 : 0;

          trades.push({
            title, asset,
            side:       m.buys[0]?.outcome || '?',
            entryPrice: avgEntry,
            exitPrice:  result === 'WIN' ? 1.0 : result === 'LOSS' ? 0.0 : null,
            entryTs,
            exitTs,
            holdSecs,
            cost,
            received,
            pnl,
            result,
            isOracleLag: title.includes('Up or Down'),
          });
        }
        trades.sort((a, b) => b.entryTs - a.entryTs);

        // Daily PNL (oracle-lag only, every day filled — keyed by entry date)
        // Using entry date because 5-min markets resolve ~5min after entry;
        // REDEEM txs can fire hours later and would misattribute the day.
        const dailyPnlRaw = {};
        for (const t of trades) {
          if (t.result === 'OPEN' || !t.isOracleLag) continue;
          const d = new Date(t.entryTs).toISOString().slice(0, 10);
          dailyPnlRaw[d] = Math.round(((dailyPnlRaw[d] || 0) + t.pnl) * 100) / 100;
        }
        // Fill every calendar day from first to today with 0
        const dailyPnl = {};
        if (Object.keys(dailyPnlRaw).length) {
          const firstDay = Object.keys(dailyPnlRaw).sort()[0];
          const today    = new Date().toISOString().slice(0, 10);
          for (let d = new Date(firstDay); d.toISOString().slice(0,10) <= today; d.setDate(d.getDate() + 1)) {
            const key = d.toISOString().slice(0, 10);
            dailyPnl[key] = dailyPnlRaw[key] ?? 0;
          }
        }

        // Balance history: reconstruct actual wallet balance at each activity event
        // Start from current balance and walk backwards through activity
        let currentBal = this._polyClient ? await this._polyClient.getBalance().catch(() => this.state.balance)
                                          : this.state.balance;
        const sortedActs = [...activity].sort((a, b) => b.timestamp - a.timestamp); // newest first
        const balPoints  = [{ ts: Date.now(), balance: Math.round(currentBal * 100) / 100 }];
        let bal = currentBal;
        for (const act of sortedActs) {
          const sz = parseFloat(act.usdcSize) || 0;
          if (act.type === 'TRADE' && act.side === 'BUY')  bal += sz;   // reverse buy  → balance was higher
          if (act.type === 'TRADE' && act.side === 'SELL') bal -= sz;   // reverse sell → balance was lower
          if (act.type === 'REDEEM')                        bal -= sz;   // reverse redeem
          if (act.type === 'YIELD')                         bal -= sz;   // reverse yield
          balPoints.push({ ts: act.timestamp * 1000, balance: Math.round(bal * 100) / 100 });
        }
        const balanceHistory = balPoints.sort((a, b) => a.ts - b.ts);  // chronological

        // By-asset summary (oracle lag only)
        const byAsset = {};
        for (const t of trades) {
          if (!t.isOracleLag) continue;
          if (!byAsset[t.asset]) byAsset[t.asset] = { pnl: 0, wins: 0, losses: 0, trades: 0, cost: 0 };
          byAsset[t.asset].pnl    = Math.round((byAsset[t.asset].pnl + t.pnl) * 100) / 100;
          byAsset[t.asset].cost  += t.cost;
          byAsset[t.asset].trades++;
          if (t.result === 'WIN')  byAsset[t.asset].wins++;
          if (t.result === 'LOSS') byAsset[t.asset].losses++;
        }

        const totalYield = activity.filter(a => a.type === 'YIELD')
          .reduce((s, a) => s + (parseFloat(a.usdcSize) || 0), 0);

        // Win rate by CLOB entry price bucket (oracle lag only, settled trades)
        // entryPrice = token buy price ≈ CLOB ask at trigger time
        const byPriceBucket = {};
        for (const t of trades) {
          if (!t.isOracleLag || t.result === 'OPEN') continue;
          const p = t.entryPrice || 0;
          const bucket = p < 0.20 ? '<0.20'
                       : p < 0.30 ? '0.20-0.30'
                       : p < 0.38 ? '0.30-0.38'
                       : '≥0.38';
          if (!byPriceBucket[bucket]) byPriceBucket[bucket] = { wins: 0, losses: 0, pnl: 0, cost: 0 };
          byPriceBucket[bucket].pnl  = Math.round((byPriceBucket[bucket].pnl + t.pnl) * 100) / 100;
          byPriceBucket[bucket].cost += t.cost;
          if (t.result === 'WIN')  byPriceBucket[bucket].wins++;
          if (t.result === 'LOSS') byPriceBucket[bucket].losses++;
        }

        // Path breakdown from bet_log.json (local file has path label for each trade)
        const byPath = {};
        try {
          const fs = require('fs');
          const betLogFile = require('path').join(__dirname, '..', 'bet_log.json');
          if (fs.existsSync(betLogFile)) {
            const betLog = JSON.parse(fs.readFileSync(betLogFile, 'utf8'));
            for (const b of betLog) {
              if (!b.path || !b.marketId) continue;
              const primaryPath = (b.path || '').split('+')[0]; // EARLY, SPIKE, WINDOW, REVERSAL
              if (!byPath[primaryPath]) byPath[primaryPath] = { trades: 0, cost: 0 };
              byPath[primaryPath].trades++;
              byPath[primaryPath].cost += parseFloat(b.size) || 0;
            }
          }
        } catch { /* bet_log optional */ }

        res.json({ trades, dailyPnl, balanceHistory, byAsset, byPriceBucket, byPath, totalYield });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Sell an open position via CLOB GTC order
    this.app.post('/api/sell', async (req, res) => {
      try {
        const { tokenId, size, price } = req.body;
        if (!tokenId || !size || !price) return res.status(400).json({ error: 'tokenId, size, price required' });
        const { PolymarketClient } = require('./polymarket');
        // Use the engine's poly client if available, otherwise error
        if (!this._polyClient) return res.status(503).json({ error: 'Bot not ready' });
        const order = await this._polyClient.placeSellOrder(tokenId, parseFloat(price), parseFloat(size));
        if (order?.error || !order?.orderID) return res.status(400).json({ error: order?.error || 'Order rejected' });
        res.json({ success: true, orderId: order.orderID });
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

    // Try each RPC until one returns the nonce successfully
    let nonce;
    for (const rpc of POLY_RPCS) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        nonce = await provider.getTransactionCount(wallet.address);
        break;
      } catch { /* try next */ }
    }
    if (nonce == null) throw new Error('All RPCs failed to get nonce');
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
    const prev = this.state.balance || 0;
    this.state.balance         = balance;
    this.state.realizedPnl     = stats.realizedPnl;
    this.state.openPositions   = stats.openPositions;
    this.state.totalInvested   = stats.totalInvested;
    this.state.winCount        = stats.winCount;
    this.state.lossCount       = stats.lossCount;
    this.state.positions       = stats.positions;
    this.state.recentTrades    = stats.recentTrades;
    if (stats.riskState)       this.state.riskState = stats.riskState;
    // Log when balance moves by more than $0.50 (trade settlement / redemption)
    if (prev > 0 && Math.abs(balance - prev) > 0.5) {
      const diff = balance - prev;
      this._log(`Balance: $${balance.toFixed(2)} (${diff >= 0 ? '+' : ''}$${diff.toFixed(2)})`, diff >= 0 ? 'success' : 'warn');
    }
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

  tradeCancelled(orderId) {
    this.state.tradesExecuted = Math.max(0, this.state.tradesExecuted - 1);
    this._log(`Order cancelled (unfilled): ${orderId.slice(0, 20)}…`, 'warn');
    this._broadcast();
  }

  oracleScanTick(data) {
    // data: { symbol, path, pctWindow, spike60, clobPrice, maxClobPrice, direction, status, msLeft }
    this.state.oracleScan = this.state.oracleScan || {};
    this.state.oracleScan[data.symbol] = { ...data, ts: Date.now() };
    this.state.scanCount = (this.state.scanCount || 0) + 1;
    this.io.emit('oracle_scan', data);

    // Log meaningful signal detections (skip routine 'watching' noise)
    const realPath = data.path && data.path !== 'watching' && data.path !== 'SIGNAL';
    if (realPath) {
      const w    = `${data.pctWindow >= 0 ? '+' : ''}${(data.pctWindow * 100).toFixed(3)}%`;
      const clob = `CLOB=${data.clobPrice?.toFixed(3)} max=${data.maxClobPrice?.toFixed(2)}`;
      const skip = data.status === 'skip' ? ' ⛔ SKIP' : ' 🎯';
      this._log(`[${data.path}] ${data.symbol} ${data.direction} window=${w} ${clob}${skip}`, data.status === 'skip' ? 'warn' : 'success');
    }
  }

  cryptoPriceUpdate(prices) {
    this.state.cryptoPrices = prices;
    this.io.emit('prices', prices);
  }

  scanUpdate(scanCount) {
    if (scanCount > 0) this.state.scanCount = scanCount;  // don't overwrite oracle-lag count with 0
    this._broadcast();
  }

  stopped() {
    this.state.status = 'STOPPED';
    this._log('Bot stopped', 'warn');
    this._broadcast();
  }

  // ── Server ──────────────────────────────────────────────────────────────────

  close() {
    try { this.server.close(); } catch {}
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[Dashboard] Port ${this.config.dashboardPort} in use — killing old process and retrying`);
          const { execSync } = require('child_process');
          try {
            execSync(
              `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${this.config.dashboardPort} ^| findstr LISTENING') do taskkill /PID %a /F`,
              { shell: 'cmd.exe', stdio: 'ignore', timeout: 5000 }
            );
          } catch {}
          setTimeout(() => {
            this.server.listen(this.config.dashboardPort, () => {
              console.log(`[Dashboard] http://localhost:${this.config.dashboardPort}`);
              resolve();
            });
          }, 1500);
        } else {
          reject(err);
        }
      });
      this.server.listen(this.config.dashboardPort, () => {
        console.log(`[Dashboard] http://localhost:${this.config.dashboardPort}`);
        resolve();
      });
    });
  }
}

module.exports = { Dashboard };
