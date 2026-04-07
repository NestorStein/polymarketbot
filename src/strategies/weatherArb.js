'use strict';

/**
 * Weather Arbitrage — bet on temperature prediction markets using free forecast data.
 *
 * Polymarket has 50-70 active "Will the highest temperature in [city] be X°C on [date]?"
 * markets at any time. These resolve against official weather station data.
 *
 * Edge: Open-Meteo provides free, high-accuracy forecasts. When the market price
 * diverges from the model probability by ≥12%, we have an edge.
 *
 * Three question patterns handled:
 *   A) "be X°C or higher"    → P(T_max ≥ X)
 *   B) "be X°C or below"     → P(T_max ≤ X)
 *   C) "be X°C" (exact)      → P(X-0.5 ≤ T_max < X+0.5)
 *   D) "be between X-Y°F"    → P(X°C ≤ T_max ≤ Y°C) — skipped (too narrow)
 *
 * APIs used (all free, no key needed):
 *   Geocoding: https://geocoding-api.open-meteo.com
 *   Forecast:  https://api.open-meteo.com
 */

const axios      = require('axios');
const EventEmitter = require('events');

const GEO_URL      = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GAMMA_URL    = 'https://gamma-api.polymarket.com/markets';
const CLOB_URL     = 'https://clob.polymarket.com/price';

// ── Normal CDF (Abramowitz & Stegun approximation, max error 7.5e-8) ──────────
function normCdf(x) {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-x * x));
  return 0.5 * (1 + sign * y);
}

// ── In-memory caches ──────────────────────────────────────────────────────────
const geoCache      = new Map();  // cityName → { lat, lon, ts }
const forecastCache = new Map();  // `${lat},${lon},${date}` → { maxTemp, ts }

class WeatherArb extends EventEmitter {
  constructor(config, polyClient) {
    super();
    this.config        = config;
    this.poly          = polyClient;
    this.running       = false;
    this.scanning      = false;
    this.tradedMarkets = new Set();  // conditionIds already bet this session
  }

  async start() {
    this.running = true;
    // First scan after a short delay (let main strategy connect first)
    setTimeout(() => this._scan().catch(e => console.warn('[Weather] Scan error:', e.message)), 15_000);
    // Then every 30 minutes
    setInterval(() => {
      if (!this.running || this.scanning) return;
      this._scan().catch(e => console.warn('[Weather] Scan error:', e.message));
    }, 30 * 60 * 1000);
    console.log('[Weather] Started — scanning temperature prediction markets every 30min');
  }

  stop() { this.running = false; }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main scan loop
  // ─────────────────────────────────────────────────────────────────────────────

  async _scan() {
    this.scanning = true;
    let checked = 0, edgeFound = 0;
    try {
      const markets = await this._fetchWeatherMarkets();
      const now = Date.now();
      const viable = markets.filter(m => {
        const daysLeft = (new Date(m.endDate) - now) / 86400000;
        return daysLeft >= 0.4 && daysLeft <= 5
          && parseFloat(m.liquidity || 0) >= 300
          && !this.tradedMarkets.has(m.conditionId);
      });

      console.log(`[Weather] Scanning ${viable.length} viable markets (of ${markets.length} total)`);

      for (const market of viable) {
        if (!this.running) break;

        const parsed = this._parseQuestion(market.question);
        if (!parsed) continue;
        checked++;

        const { city, tempC, comparison, targetDate } = parsed;
        const daysLeft = (new Date(market.endDate) - now) / 86400000;

        // Forecast uncertainty grows with time (°C)
        const sigma = daysLeft < 1.5 ? 2.0 : daysLeft < 3.0 ? 2.8 : 3.5;

        // Fetch forecast
        const forecast = await this._getForecast(city, targetDate).catch(() => null);
        if (!forecast) continue;

        // Model probability
        const modelProb = this._computeProb(comparison, tempC, forecast.maxTemp, sigma);
        if (modelProb === null) continue;

        // CLOB prices for YES and NO tokens
        const tokens = JSON.parse(market.clobTokenIds || '[]');
        if (!tokens[0] || !tokens[1]) continue;

        const [clobYes, clobNo] = await Promise.all([
          this._getClobPrice(tokens[0]),
          this._getClobPrice(tokens[1]),
        ]);
        if (clobYes === null && clobNo === null) continue;

        const marketYes = parseFloat((JSON.parse(market.outcomePrices || '[]')[0]) || 0.5);
        const marketNo  = parseFloat((JSON.parse(market.outcomePrices || '[]')[1]) || 0.5);

        const edgeYes = clobYes !== null ? modelProb - clobYes : -1;
        const edgeNo  = clobNo  !== null ? (1 - modelProb) - clobNo : -1;

        const maxEdge = Math.max(edgeYes, edgeNo);
        if (maxEdge > 0.04) {
          console.log(`[Weather] ${city} ${comparison === 'gte' ? '≥' : comparison === 'lte' ? '≤' : '~'}${tempC.toFixed(0)}°C on ${targetDate} | forecast=${forecast.maxTemp.toFixed(1)}°C σ=${sigma} | model=${(modelProb * 100).toFixed(0)}% YES=${clobYes !== null ? (clobYes * 100).toFixed(0) + '%' : '?'} NO=${clobNo !== null ? (clobNo * 100).toFixed(0) + '%' : '?'} | edgeYES=${(edgeYes * 100).toFixed(0)}% edgeNO=${(edgeNo * 100).toFixed(0)}%`);
        }

        const EDGE_THRESHOLD = 0.12;

        const tickSize = parseFloat(market.orderPriceMinTickSize || 0.001);
        const negRisk  = !!market.negRisk;

        if (edgeYes >= EDGE_THRESHOLD && clobYes !== null && clobYes < 0.88) {
          edgeFound++;
          await this._executeTrade(market, tokens[0], 'YES', clobYes, modelProb, city, tempC, comparison, targetDate, tickSize, negRisk);
        } else if (edgeNo >= EDGE_THRESHOLD && clobNo !== null && clobNo < 0.88) {
          edgeFound++;
          await this._executeTrade(market, tokens[1], 'NO', clobNo, 1 - modelProb, city, tempC, comparison, targetDate, tickSize, negRisk);
        }

        await new Promise(r => setTimeout(r, 400)); // rate limit between markets
      }

      console.log(`[Weather] Scan complete: ${checked} checked, ${edgeFound} edges found`);
    } finally {
      this.scanning = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Probability model
  // ─────────────────────────────────────────────────────────────────────────────

  _computeProb(comparison, thresholdC, forecastMaxC, sigma) {
    switch (comparison) {
      case 'gte':
        // "or higher / or above": P(T_max ≥ threshold)
        return 1 - normCdf((thresholdC - forecastMaxC) / sigma);
      case 'lte':
        // "or below / or lower": P(T_max ≤ threshold)
        return normCdf((thresholdC - forecastMaxC) / sigma);
      case 'exact':
        // "be X°C" (to nearest integer): P(X-0.5 ≤ T_max < X+0.5)
        return normCdf((thresholdC + 0.5 - forecastMaxC) / sigma)
             - normCdf((thresholdC - 0.5 - forecastMaxC) / sigma);
      default:
        return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Question parser
  // ─────────────────────────────────────────────────────────────────────────────

  _parseQuestion(question) {
    if (!question) return null;

    // Pattern A/B: "be X°C or higher/lower/above/below"
    const patternAB = question.match(
      /highest temperature in (.+?) be ([\d.]+)\s*°?([CF])\s+or\s+(higher|lower|above|below)\s+on\s+(.+?)(?:\?|$)/i
    );
    if (patternAB) {
      const city       = patternAB[1].trim();
      const tempRaw    = parseFloat(patternAB[2]);
      const unit       = patternAB[3].toUpperCase();
      const qualifier  = patternAB[4].toLowerCase();
      const dateStr    = patternAB[5].trim();
      const tempC      = unit === 'F' ? (tempRaw - 32) * 5 / 9 : tempRaw;
      const comparison = (qualifier === 'higher' || qualifier === 'above') ? 'gte' : 'lte';
      const targetDate = this._parseDate(dateStr);
      if (!targetDate) return null;
      return { city, tempC, comparison, targetDate };
    }

    // Pattern C: "be X°C" (exact — no qualifier)
    const patternC = question.match(
      /highest temperature in (.+?) be ([\d.]+)\s*°?([CF])\s+on\s+(.+?)(?:\?|$)/i
    );
    if (patternC) {
      const city    = patternC[1].trim();
      const tempRaw = parseFloat(patternC[2]);
      const unit    = patternC[3].toUpperCase();
      const dateStr = patternC[4].trim();
      const tempC   = unit === 'F' ? (tempRaw - 32) * 5 / 9 : tempRaw;
      const targetDate = this._parseDate(dateStr);
      if (!targetDate) return null;
      return { city, tempC, comparison: 'exact', targetDate };
    }

    return null; // skip "between X-Y" and other formats
  }

  _parseDate(dateStr) {
    // "April 9" → "2026-04-09", "April 11, 2026" → "2026-04-11"
    if (!dateStr) return null;
    // Try adding current year if not present
    const withYear = /\d{4}/.test(dateStr) ? dateStr : `${dateStr}, 2026`;
    const d = new Date(withYear);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Forecast fetching (Open-Meteo, no API key)
  // ─────────────────────────────────────────────────────────────────────────────

  async _getForecast(city, dateStr) {
    const cacheKey = `${city.toLowerCase()}_${dateStr}`;
    const cached = forecastCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 3_600_000) return cached; // 1h cache

    const geo = await this._geocode(city);
    if (!geo) return null;

    try {
      const resp = await axios.get(FORECAST_URL, {
        params: {
          latitude:  geo.lat,
          longitude: geo.lon,
          daily:     'temperature_2m_max,temperature_2m_min',
          timezone:  'auto',
          start_date: dateStr,
          end_date:   dateStr,
        },
        timeout: 6000,
      });

      const maxTemp = resp.data?.daily?.temperature_2m_max?.[0];
      const minTemp = resp.data?.daily?.temperature_2m_min?.[0];
      if (maxTemp == null) return null;

      const result = { maxTemp, minTemp, ts: Date.now() };
      forecastCache.set(cacheKey, result);
      return result;
    } catch { return null; }
  }

  async _geocode(city) {
    const key = city.toLowerCase();
    const cached = geoCache.get(key);
    if (cached && Date.now() - cached.ts < 86_400_000) return cached; // 24h cache

    try {
      const resp = await axios.get(GEO_URL, {
        params: { name: city, count: 1, language: 'en', format: 'json' },
        timeout: 4000,
      });
      const r = resp.data?.results?.[0];
      if (!r) return null;
      const geo = { lat: r.latitude, lon: r.longitude, ts: Date.now() };
      geoCache.set(key, geo);
      return geo;
    } catch { return null; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CLOB price fetch
  // ─────────────────────────────────────────────────────────────────────────────

  async _getClobPrice(tokenId) {
    try {
      const res = await axios.get(CLOB_URL, {
        params: { token_id: tokenId, side: 'buy' },
        timeout: 2500,
      });
      const p = parseFloat(res.data?.price);
      return isNaN(p) ? null : p;
    } catch { return null; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trade execution
  // ─────────────────────────────────────────────────────────────────────────────

  async _executeTrade(market, tokenId, side, clobPrice, modelProb, city, tempC, comparison, targetDate, tickSize = 0.001, negRisk = true) {
    try {
      const balance   = await this.poly.getBalance().catch(() => 0);
      const reserve   = this.config.reserveUsdc || 5;
      const available = balance - reserve;
      if (available < 5) {
        console.log(`[Weather] Balance too low ($${balance.toFixed(2)}) — skipping`);
        return;
      }

      // Sizing: 10% of available, capped at $8, min $5
      const fraction = modelProb >= 0.80 ? 0.12 : 0.08;
      const size = Math.min(8, Math.max(5, available * fraction));
      if (size < 5) return;

      this.tradedMarkets.add(market.conditionId);

      const bidOffset  = 0.06;
      const decimals   = tickSize <= 0.001 ? 3 : 2;
      const fillPrice  = Math.min(parseFloat((clobPrice + bidOffset).toFixed(decimals)), 0.92);
      const compSymbol = comparison === 'gte' ? '≥' : comparison === 'lte' ? '≤' : '~';

      console.log(`[Weather] BUY ${side} ${city} ${compSymbol}${tempC.toFixed(0)}°C on ${targetDate} | model=${(modelProb*100).toFixed(0)}% clob=${(clobPrice*100).toFixed(0)}% → fill@${fillPrice} size=$${size.toFixed(2)}`);

      const { OrderType } = require('@polymarket/clob-client');
      const order = await this.poly.placeBuyOrder(tokenId, fillPrice, size, tickSize, negRisk, OrderType.GTC);

      if (order?.error || !order?.orderID) {
        console.warn(`[Weather] Order rejected: ${order?.error || 'no orderID'}`);
        this.tradedMarkets.delete(market.conditionId);
        return;
      }

      console.log(`[Weather] Order placed: ${order.orderID?.slice(0, 20)}… status=${order.status}`);

      this.emit('trade_executed', {
        type: 'WEATHER',
        market: market.question,
        marketId: market.conditionId,
        marketUrl: `https://polymarket.com/event/${market.slug || ''}`,
        side, price: clobPrice, size,
        orderId: order.orderID,
        path: 'WEATHER',
        ts: Date.now(),
      });

      // Cancel after 5 minutes if unfilled (weather books are thin)
      setTimeout(async () => {
        try {
          await this.poly.cancelOrder(order.orderID);
          console.log(`[Weather] Order cancelled (unfilled): ${order.orderID?.slice(0, 20)}…`);
          this.emit('trade_cancelled', { orderId: order.orderID });
          this.tradedMarkets.delete(market.conditionId); // allow retry next scan
        } catch {
          console.log(`[Weather] Order filled: ${order.orderID?.slice(0, 20)}…`);
        }
      }, 5 * 60 * 1000);

    } catch (err) {
      console.warn('[Weather] Trade error:', err.message);
      this.tradedMarkets.delete(market.conditionId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Market discovery
  // ─────────────────────────────────────────────────────────────────────────────

  async _fetchWeatherMarkets() {
    try {
      const resp = await axios.get(
        `${GAMMA_URL}?closed=false&limit=500&order=volume&ascending=false`,
        { timeout: 10000 }
      );
      return (resp.data || []).filter(m =>
        (m.question || '').match(/highest temperature/i) &&
        m.conditionId &&
        m.acceptingOrders !== false &&
        m.active !== false
      );
    } catch (err) {
      console.warn('[Weather] Market fetch failed:', err.message);
      return [];
    }
  }
}

module.exports = { WeatherArb };
