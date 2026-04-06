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
    this.oracleLag.on('trade_cancelled', ({ orderId }) => {
      this.tradesExecuted = Math.max(0, this.tradesExecuted - 1);
      this.dashboard?.tradeCancelled(orderId);
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
      };
      log.push(entry);
      fs.writeFileSync(file, JSON.stringify(log, null, 2));
    } catch (err) {
      console.warn('[Strategy] bet_log write failed:', err.message);
    }
  }

  getStats() {
    const riskState = this.oracleLag ? {
      sessionPeak:     this.oracleLag.sessionPeak,
      dayStartBalance: this.oracleLag.dayStartBalance,
      // dailyLoss and drawdownPct are recomputed against live balance in dashboard.balanceUpdate
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
