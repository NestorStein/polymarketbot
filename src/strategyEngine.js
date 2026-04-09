'use strict';

/**
 * Strategy engine — orchestrates all strategies:
 *
 *  [FAST - WebSocket driven]
 *  1. COMPLEMENT_ARB  — buy YES+NO when sum < 1.00 (guaranteed profit, ~2.7s windows)
 *  2. ORACLE_LAG_ARB  — spot price moves before order book reprices (55s window)
 *  3. RESOLUTION_SNIPE — buy near-certain tokens in final 20s before close
 *
 *  [SLOW - Signal driven, 30s scan cycle]
 *  4. SIGNAL_TRADE    — buy YES or NO based on news + twitter + cross-platform signals
 */

const { PolymarketClient }    = require('./polymarket');
const { SignalAggregator }    = require('./signals/signalAggregator');
const { RiskManager }         = require('./riskManager');
const { NewsFeed }            = require('./signals/newsFeed');
const { OracleLagArb }        = require('./strategies/oracleLagArb');
const { ResolutionSnipe }     = require('./strategies/resolutionSnipe');
const { ClobWebSocket }       = require('./strategies/clobWebSocket');
const { EndgameBond }         = require('./strategies/endgameBond');
const { GeopoliticsScanner }  = require('./strategies/geopoliticsScanner');

class StrategyEngine {
  constructor(config, dashboard) {
    this.config    = config;
    this.dashboard = dashboard;
    this.poly      = new PolymarketClient(config);
    this.signals   = new SignalAggregator(config);
    this.risk      = new RiskManager(config);
    this.clobWs    = new ClobWebSocket();

    this.oracleLag  = null; // initialized after poly.init()
    this.sniper     = null;
    this.bond       = new EndgameBond(config, this.poly, this.risk);
    this.geoScanner = new GeopoliticsScanner(config);

    this.running   = false;
    this.scanCount = 0;
    this.opportunitiesFound  = 0;
    this.tradesExecuted = 0;

    // Track watched tokens for complement arb via WebSocket
    this.watchedMarkets = new Map(); // marketId → { yesTokenId, noTokenId, question, category }
  }

  async start() {
    console.log('[Strategy] Initializing Polymarket client...');
    const ok = await this.poly.init();
    if (!ok) {
      console.error('[Strategy] Polymarket init failed. Check POLYGON_PRIVATE_KEY in .env');
      return false;
    }

    const balance = await this.poly.getBalance();
    this.risk.setStartBalance(balance);
    console.log(`[Strategy] Wallet: ${this.poly.wallet.address}`);
    console.log(`[Strategy] USDC balance: $${balance.toFixed(2)}`);

    if (this.dashboard) this.dashboard._polyClient = this.poly;
    this.dashboard?.botStart({ wallet: this.poly.wallet.address, balance });


    const oracleLagOnly = this.config.oracleLagOnly;

    // ── Start signal sources (price feed always needed; news/twitter only if full mode) ──
    await this.signals.start(oracleLagOnly);

    // ── Start oracle lag arb (real-time Binance WS) ────────────────────────
    this.oracleLag = new OracleLagArb(this.config, this.poly);
    this.oracleLag.on('opportunity', opp => {
      this.opportunitiesFound++;
      this.dashboard?.arbFound({ ...opp, profitPct: parseFloat(opp.expectedEdge) });
    });
    this.oracleLag.on('trade_executed', trade => {
      this.tradesExecuted++;
      this.dashboard?.tradeExecuted(trade);
      this._appendBetLog(trade);
    });
    this.oracleLag.on('trade_cancelled', ({ orderId, marketId }) => {
      this.tradesExecuted = Math.max(0, this.tradesExecuted - 1);
      this.dashboard?.tradeCancelled(orderId);
      this._markBetCancelled(orderId);
    });
    this.oracleLag.on('scan_tick', data => {
      this.dashboard?.oracleScanTick(data);
    });
    this.oracleLag.on('ai_verdict', ({ symbol, direction, verdict, conf, summary, pass }) => {
      const icon = pass ? '✅' : '🚫';
      const msg  = `[AI] ${symbol} ${direction} → ${verdict} ${(conf*100).toFixed(0)}% conf ${icon} | ${summary?.slice(0,80)}`;
      this.dashboard?._log(msg, pass ? 'success' : 'warn');
    });
    this.oracleLag.on('circuit_breaker', ({ reason, dailyLoss, maxDailyLoss, balance }) => {
      const msg = `⛔ CIRCUIT BREAKER — daily loss $${dailyLoss.toFixed(2)} hit limit $${maxDailyLoss}. Trading paused for today. Balance: $${balance.toFixed(2)}`;
      this.dashboard?._log(msg, 'error');
      if (this.dashboard) this.dashboard.state.status = 'PAUSED';
    });
    await this.oracleLag.start();

    if (!oracleLagOnly) {
      // ── Start resolution sniper ──────────────────────────────────────────
      this.sniper = new ResolutionSnipe(this.config, this.poly, this.signals.priceFeed);
      this.sniper.on('opportunity', opp => {
        this.opportunitiesFound++;
        this.dashboard?.arbFound({ ...opp, market: opp.market, profitPct: opp.profitPct / 100 });
      });
      this.sniper.on('trade_executed', trade => {
        this.tradesExecuted++;
        this.dashboard?.tradeExecuted(trade);
      });
      this.sniper.start();

      // ── Wire up endgame bond events ────────────────────────────────────────
      this.bond.on('opportunity', opp => {
        this.opportunitiesFound++;
        this.dashboard?.arbFound({ ...opp, profitPct: parseFloat(opp.netReturn) / 100 });
      });
      this.bond.on('trade_executed', trade => {
        this.tradesExecuted++;
        this.dashboard?.tradeExecuted(trade);
      });

      // ── Start CLOB WebSocket (real-time order book for complement arb) ───
      this.clobWs.connect();
      this.clobWs.on('price_change', ({ tokenId, bestAsk }) => {
        this._checkComplementArbFromWs(tokenId, bestAsk);
      });
    } else {
      console.log('[Strategy] ORACLE-LAG-ONLY mode — complement arb, bond, and signal trades disabled');
    }

    // Relay crypto prices to dashboard
    this.signals.priceFeed.on('price', () => {
      this.dashboard?.cryptoPriceUpdate(this.signals.priceFeed.getCurrentPrices());
    });

    // ── Start slow scan loop (signal trades + market discovery) ───────────
    this.running = true;
    if (!oracleLagOnly) this._runLoop();

    return true;
  }

  // ── Main scan loop (30s cycle) ─────────────────────────────────────────────

  async _runLoop() {
    while (this.running) {
      try {
        await this._scan();
      } catch (err) {
        console.error('[Strategy] Scan error:', err.message);
      }
      await sleep(30000);
    }
  }

  async _scan() {
    this.scanCount++;
    console.log(`\n[Strategy] ── Scan #${this.scanCount} ──`);

    // Fetch regular markets + geopolitics markets (0% fee)
    const [markets, geoMarkets] = await Promise.all([
      this.poly.getActiveMarkets(100),
      this.geoScanner.getMarkets(),
    ]);

    // Merge, deduplicate
    const seenIds = new Set(markets.map(m => m.id));
    const allMarkets = [...markets, ...geoMarkets.filter(m => !seenIds.has(m.id))];
    if (!allMarkets.length) return;

    console.log(`[Strategy] Scanning ${allMarkets.length} markets (${geoMarkets.length} geo, 0% fee)...`);

    const balance = await this.poly.getBalance();
    this.dashboard?.balanceUpdate(balance, this.risk.getStats());

    // Prune endgame bond traded set
    this.bond.pruneTraded(new Set(allMarkets.map(m => m.id)));

    for (const market of allMarkets) {
      if (!this.running) break;

      // Register crypto markets with resolution sniper
      const q = (market.question || '').toLowerCase();
      const isShortTerm = q.includes('5-minute') || q.includes('15-minute') || q.includes('next hour');
      if (isShortTerm) this.sniper.watchMarket(market);

      // Subscribe new market tokens to CLOB WebSocket for real-time complement arb
      this._registerMarketWs(market);

      // REST-based complement arb check (fee-aware)
      const arbOpp = await this.poly.findComplementArb(market);
      if (arbOpp && arbOpp.profitPct > this.config.minArbProfitPct) {
        this.opportunitiesFound++;
        console.log(`[ARB] ${arbOpp.market?.slice(0, 60)} | profit ${(arbOpp.profitPct * 100).toFixed(2)}%`);
        this.dashboard?.arbFound(arbOpp);
        if (this.risk.canTrade(market.id)) {
          await this._executeCompArb(arbOpp, balance);
        }
        continue;
      }

      // Endgame bond check (near-certain tokens at $0.88–$0.99)
      const bondOpp = this.bond.evaluate(market);
      if (bondOpp) {
        this.opportunitiesFound++;
        console.log(`[Bond] ${bondOpp.outcome} @ $${bondOpp.price} | +${bondOpp.netReturn}% | ${bondOpp.hoursLeft}h | ${bondOpp.market}`);
        if (this.risk.canTrade(market.id)) {
          await this.bond.execute(bondOpp, balance);
        }
        continue;
      }

      // Signal-based trade (slower, for longer-dated markets)
      if (!this.risk.canTrade(market.id)) continue;
      if (isShortTerm) continue; // oracle lag handles short-term

      const analysis = await this.signals.analyzeMarket(market);
      if (analysis.recommendation === 'SKIP') continue;

      console.log(`[SIGNAL] ${market.question?.slice(0, 60)}`);
      console.log(`         → ${analysis.recommendation} conf=${(analysis.confidence * 100).toFixed(0)}% | ${analysis.reasoning}`);
      this.dashboard?.signalFound({ market: market.question, ...analysis });

      if (analysis.confidence >= this.config.sentimentThreshold) {
        await this._executeSignalTrade(market, analysis, balance);
      }
    }

    const stats = this.risk.getStats();
    console.log(`[Strategy] Done. Positions: ${stats.openPositions} | PnL: $${stats.realizedPnl.toFixed(4)}`);
  }

  // ── WebSocket-driven complement arb ────────────────────────────────────────

  _registerMarketWs(market) {
    if (this.watchedMarkets.has(market.id)) return;
    const { PolymarketClient } = require('./polymarket');
    const tokenIds = PolymarketClient.parseTokenIds(market);
    if (tokenIds.length < 2) return;

    this.watchedMarkets.set(market.id, {
      yesTokenId: tokenIds[0],
      noTokenId:  tokenIds[1],
      question:   market.question || '',
      marketId:   market.id,
      negRisk:    !!market.negRisk,
      category:   PolymarketClient.categorizeMarket(market),
    });

    this.clobWs.subscribeTokens([tokenIds[0], tokenIds[1]]);
  }

  _checkComplementArbFromWs(changedTokenId, changedAsk) {
    // Find the market this token belongs to
    for (const [marketId, info] of this.watchedMarkets) {
      const isYes = info.yesTokenId === changedTokenId;
      const isNo  = info.noTokenId  === changedTokenId;
      if (!isYes && !isNo) continue;

      // Get the other token's price from WS cache
      const otherTokenId = isYes ? info.noTokenId : info.yesTokenId;
      const otherAsk = this.clobWs.getBestAsk(otherTokenId);
      if (otherAsk === null) continue;

      const yesAsk = isYes ? changedAsk : otherAsk;
      const noAsk  = isNo  ? changedAsk : otherAsk;
      const totalCost = yesAsk + noAsk;
      const feeRate   = this.config.fees?.[info.category]?.taker ?? 0.01;
      const feeBuffer = feeRate * 2;
      const minProfit = (this.config.minEdgeMultiplier ?? 1.5) * feeBuffer;
      const profit    = 1.0 - totalCost - feeBuffer;

      if (profit > minProfit) {
        this.opportunitiesFound++;
        const opp = {
          type: 'COMPLEMENT_ARB',
          market: info.question?.slice(0, 60),
          marketId,
          yesTokenId: info.yesTokenId,
          noTokenId: info.noTokenId,
          yesAsk,
          noAsk,
          totalCost,
          profitPct: profit,
          negRisk: info.negRisk,
          source: 'websocket',
        };
        console.log(`[ARB-WS] ${opp.market} | profit ${(profit * 100).toFixed(2)}%`);
        this.dashboard?.arbFound(opp);

        if (this.risk.canTrade(marketId)) {
          const balance = this.risk.startBalance; // use cached balance for WS-driven trades
          this._executeCompArb(opp, balance).catch(() => {});
        }
      }
      break;
    }
  }

  // ── Trade execution ────────────────────────────────────────────────────────

  async _executeCompArb(arb, balance) {
    const avgPrice    = (arb.yesAsk + arb.noAsk) / 2;
    const sizePerSide = this.risk.sizePosition(0.9, balance, avgPrice) / 2;
    if (sizePerSide < 5) { console.log('[ARB] Balance too low for arb'); return; }

    try {
      console.log(`[ARB] YES $${sizePerSide.toFixed(2)} @ ${arb.yesAsk} + NO $${sizePerSide.toFixed(2)} @ ${arb.noAsk}`);
      const negRisk = arb.negRisk ?? (this.watchedMarkets.get(arb.marketId)?.negRisk ?? false);
      const [yesOrder, noOrder] = await Promise.all([
        this.poly.placeBuyOrder(arb.yesTokenId, arb.yesAsk, sizePerSide, 0.01, negRisk),
        this.poly.placeBuyOrder(arb.noTokenId,  arb.noAsk,  sizePerSide, 0.01, negRisk),
      ]);
      this.tradesExecuted++;
      console.log(`[ARB] Orders placed — YES: ${yesOrder?.orderID} | NO: ${noOrder?.orderID}`);
      this.dashboard?.tradeExecuted({ type: 'COMP_ARB', ...arb, sizePerSide });
    } catch (err) {
      console.error('[ARB] Order failed:', err.message);
    }
  }

  async _executeSignalTrade(market, analysis, balance) {
    const { PolymarketClient } = require('./polymarket');
    const tokenIds = PolymarketClient.parseTokenIds(market);
    if (tokenIds.length < 2) { console.log('[SIGNAL] No token IDs, skipping'); return; }

    const isBuyYes = analysis.recommendation === 'BUY_YES';
    // outcomes[0]=Yes, outcomes[1]=No; clobTokenIds[0]=Yes token, clobTokenIds[1]=No token
    // Gamma API returns these as JSON strings — must parse before indexing
    let outcomes = market.outcomes || ['Yes', 'No'];
    if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = ['Yes', 'No']; } }
    let prices = market.outcomePrices || ['0.5', '0.5'];
    if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = ['0.5', '0.5']; } }
    const targetIdx    = isBuyYes ? 0 : 1;
    const tokenId      = tokenIds[targetIdx];
    const price        = parseFloat(prices[targetIdx]) || 0.5;
    const side         = outcomes[targetIdx] || (isBuyYes ? 'Yes' : 'No');

    const size = this.risk.sizePosition(analysis.confidence, balance, price);
    if (size < 5) { console.log('[SIGNAL] Position too small, skipping'); return; }

    // Sanity: don't buy at >82¢ (low upside)
    if (price > 0.82) { console.log(`[SIGNAL] Price too high (${price}), skipping`); return; }

    try {
      console.log(`[SIGNAL] BUY ${side} $${size.toFixed(2)} @ ${price.toFixed(3)} | ${market.question?.slice(0,50)}`);
      const tickSize = parseFloat(market.orderPriceMinTickSize) || 0.01;
      const order = await this.poly.placeBuyOrder(tokenId, price, size, tickSize, market.negRisk);
      this.tradesExecuted++;
      this.risk.openPosition(market.id, tokenId, side, size, size / price, price);
      console.log(`[SIGNAL] ✅ Order placed: ${JSON.stringify(order).slice(0,80)}`);
      this.dashboard?.tradeExecuted({ type: 'SIGNAL', market: market.question, side, size, price, ...analysis });
    } catch (err) {
      console.error('[SIGNAL] Order failed:', err.message.slice(0,120));
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  pause() {
    if (this.oracleLag) this.oracleLag.paused = true;
    console.log('[Strategy] Trading PAUSED');
  }

  resume() {
    if (this.oracleLag) this.oracleLag.paused = false;
    console.log('[Strategy] Trading RESUMED');
  }

  isPaused() {
    return !!(this.oracleLag?.paused);
  }

  stop() {
    this.running = false;
    this.oracleLag?.stop();
    this.sniper?.stop();
    this.clobWs?.disconnect();
    this.signals.stop();
    console.log('[Strategy] All strategies stopped');
  }

  /** Append a trade entry to bet_log.json for analytics (path, CLOB price, etc.) */
  _appendBetLog(trade) {
    const fs   = require('fs');
    const file = require('path').join(__dirname, '..', 'bet_log.json');
    try {
      let log = [];
      if (fs.existsSync(file)) {
        try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { log = []; }
      }
      const entry = {
        ts:        trade.ts || Date.now(),
        time:      new Date(trade.ts || Date.now()).toLocaleTimeString(),
        market:    trade.market,
        marketId:  trade.marketId,
        marketUrl: trade.marketUrl || '',
        side:      trade.side,
        price:     trade.price,   // CLOB ask at trigger time
        size:      trade.size,
        orderId:   trade.orderId,
        path:      trade.path,
        latency:   trade.latency || null,  // { signalToSubmitMs, submitToConfirmMs, totalMs }
      };
      log.push(entry);
      fs.writeFileSync(file, JSON.stringify(log, null, 2));

      // Log latency distribution across all instrumented trades
      if (trade.latency) {
        const samples = log.filter(e => e.latency?.totalMs).map(e => e.latency.totalMs).sort((a, b) => a - b);
        if (samples.length >= 3) {
          const p = (pct) => samples[Math.floor(samples.length * pct / 100)];
          console.log(`[Latency] n=${samples.length} | signal→submit: ${trade.latency.signalToSubmitMs}ms | submit→confirm: ${trade.latency.submitToConfirmMs}ms | total p50=${p(50)}ms p90=${p(90)}ms p99=${p(99)}ms`);
        } else {
          console.log(`[Latency] signal→submit: ${trade.latency.signalToSubmitMs}ms | submit→confirm: ${trade.latency.submitToConfirmMs}ms | total: ${trade.latency.totalMs}ms (need ${3 - samples.length} more for distribution)`);
        }
      }
    } catch (err) {
      console.warn('[Strategy] bet_log write failed:', err.message);
    }
  }

  /** Mark a previously logged bet as CANCELLED (unfilled GTC order) */
  _markBetCancelled(orderId) {
    if (!orderId) return;
    const fs   = require('fs');
    const file = require('path').join(__dirname, '..', 'bet_log.json');
    try {
      if (!fs.existsSync(file)) return;
      let log = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entry = log.find(e => e.orderId === orderId);
      if (entry && !entry.result) {
        entry.result = 'CANCELLED';
        fs.writeFileSync(file, JSON.stringify(log, null, 2));
        console.log(`[Strategy] bet_log marked CANCELLED: ${orderId.slice(0, 20)}…`);
      }
    } catch (err) {
      console.warn('[Strategy] bet_log cancel mark failed:', err.message);
    }
  }

  async buildReport() {
    const fs   = require('fs');
    const path = require('path');
    const https = require('https');
    const now  = new Date();
    const utc  = now.toUTCString().replace(' GMT', ' UTC');

    // Balance / P&L
    const balance  = this.oracleLag?._cachedBalance ?? 0;
    const rawStart = this.oracleLag?.dayStartBalance ?? 0;
    const dayStart = rawStart > 0 ? rawStart : balance;  // 0 means not yet set → use current
    const pnl      = balance - dayStart;
    const pnlSign  = pnl >= 0 ? '+' : '';
    const status   = this.oracleLag?.paused ? 'PAUSED' : 'SCANNING';

    // Trade counts
    const dayTrades = this.oracleLag?.dayTradeCount    ?? 0;
    const maxTrades = this.oracleLag?.config?.maxDailyTrades ?? 3;

    // Market counts
    const markets = this.oracleLag?.markets;
    const m5  = markets ? [...markets.values()].filter(m => m._timeframe === '5m').length  : 0;
    const m15 = markets ? [...markets.values()].filter(m => m._timeframe === '15m').length : 0;
    const m4h = markets ? [...markets.values()].filter(m => m._timeframe === '4h').length  : 0;

    // Binance WS freshness
    const lastTick = this.oracleLag?.lastBinanceTick ?? 0;
    const tickAge  = lastTick ? Math.round((Date.now() - lastTick) / 1000) : null;
    const wsLine   = tickAge !== null ? `Binance WS: ${tickAge}s ago` : 'Binance WS: no data yet';

    // Helper: fetch JSON from Gamma API
    function gammaGet(urlPath) {
      return new Promise((resolve) => {
        const req = https.request(
          { hostname: 'gamma-api.polymarket.com', path: urlPath, method: 'GET', headers: { Accept: 'application/json' } },
          res => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } }); }
        );
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
        req.end();
      });
    }

    // Last 5 bets (non-cancelled), most recent first
    let betsSection = '';
    try {
      const file = path.join(__dirname, '..', 'bet_log.json');
      if (fs.existsSync(file)) {
        const log = JSON.parse(fs.readFileSync(file, 'utf8'));
        const last5 = log.filter(e => e.result !== 'CANCELLED').slice(-5).reverse();

        if (last5.length) {
          const resolved = await Promise.all(last5.map(async e => {
            if (!e.marketUrl) return { ...e, status: 'pending' };
            const slug = e.marketUrl.split('/event/')[1];
            if (!slug) return { ...e, status: 'pending' };

            const data = await gammaGet('/events?slug=' + slug);
            const mkt = Array.isArray(data) ? data[0]?.markets?.[0] : null;
            if (!mkt?.closed) return { ...e, status: 'pending' };

            // outcomePrices may be array or JSON string
            let prices   = mkt.outcomePrices;
            let outcomes = mkt.outcomes;
            if (typeof prices   === 'string') try { prices   = JSON.parse(prices);   } catch { prices   = []; }
            if (typeof outcomes === 'string') try { outcomes = JSON.parse(outcomes); } catch { outcomes = []; }

            const idx = outcomes.findIndex(o => o.toLowerCase() === (e.side || '').toLowerCase());
            if (idx === -1) return { ...e, status: 'unknown' };

            const won  = parseFloat(prices[idx]) >= 0.99;
            const betPnl = won ? e.size * (1 / (e.price || 0.5) - 1) : -e.size;
            return { ...e, status: won ? 'win' : 'loss', betPnl };
          }));

          const lines = resolved.map(e => {
            const icon  = e.status === 'win' ? '🟢' : e.status === 'loss' ? '🔴' : '⏳';
            const label = (e.market || '').replace(/.*Up or Down - /, '').slice(0, 22);
            const cost  = `$${(e.size || 0).toFixed(2)}`;
            if (e.status === 'win')  return `${icon} <b>+$${e.betPnl.toFixed(2)}</b> | ${e.side} ${label} @${(e.price||0).toFixed(2)}`;
            if (e.status === 'loss') return `${icon} <b>-$${Math.abs(e.betPnl).toFixed(2)}</b> | ${e.side} ${label} @${(e.price||0).toFixed(2)}`;
            return `${icon} ${cost} | ${e.side} ${label} @${(e.price||0).toFixed(2)} (open)`;
          });

          betsSection = '\n\n<b>Last 5 bets:</b>\n' + lines.join('\n');
        }
      }
    } catch { /* ignore */ }

    // Latency p50/p90/p99 from all instrumented trades in bet_log
    let latencyLine = '';
    try {
      const lfile = path.join(__dirname, '..', 'bet_log.json');
      if (fs.existsSync(lfile)) {
        const llog = JSON.parse(fs.readFileSync(lfile, 'utf8'));
        const samples = llog.filter(e => e.latency?.totalMs).map(e => e.latency.totalMs).sort((a, b) => a - b);
        if (samples.length >= 3) {
          const p = (pct) => samples[Math.floor(samples.length * pct / 100)];
          latencyLine = `\nLatency p50=${p(50)}ms p90=${p(90)}ms p99=${p(99)}ms (n=${samples.length})`;
        }
      }
    } catch { /* ignore */ }

    return (
      `📊 <b>Bot Report</b> — ${utc}\n` +
      `Balance: $${balance.toFixed(2)} | Day start: $${dayStart.toFixed(2)}\n` +
      `Today P&amp;L: ${pnlSign}$${pnl.toFixed(2)}\n` +
      `Trades today: ${dayTrades}/${maxTrades}\n` +
      `Markets: ${m5}×5m | ${m15}×15m | ${m4h}×4h\n` +
      `${wsLine}${latencyLine}\n` +
      `Status: <b>${status}</b>` +
      betsSection
    );
  }

  getStats() {
    const markets = this.oracleLag ? this.oracleLag.markets : null;
    const riskState = this.oracleLag ? {
      sessionPeak:      this.oracleLag.sessionPeak,
      dayStartBalance:  this.oracleLag.dayStartBalance,
      lastBinanceTick:  this.oracleLag.lastBinanceTick,
      dayTradeCount:    this.oracleLag.dayTradeCount   || 0,
      maxDailyTrades:   this.oracleLag.config?.maxDailyTrades || 3,
      markets5m:  markets ? [...markets.values()].filter(m => m._timeframe === '5m').length  : 0,
      markets15m: markets ? [...markets.values()].filter(m => m._timeframe === '15m').length : 0,
      markets4h:  markets ? [...markets.values()].filter(m => m._timeframe === '4h').length  : 0,
    } : null;
    return {
      scanCount: this.scanCount,
      opportunitiesFound: this.opportunitiesFound,
      tradesExecuted: this.tradesExecuted,
      riskState,
      ...this.risk.getStats(),
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { StrategyEngine };
