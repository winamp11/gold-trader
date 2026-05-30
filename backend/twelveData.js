import fetch from 'node-fetch';

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

class TwelveDataService {
  constructor() {
    this.callCount = 0;
    this.lastReset = new Date();
  }

  async fetchTimeSeries(symbol, interval, outputsize = 50) {
    const url = `${BASE_URL}/time_series?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&outputsize=${outputsize}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: time_series ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      return data;
    } catch (error) {
      console.error('Error fetching time series:', error.message);
      throw error;
    }
  }

  async fetchRSI(symbol, interval, timePeriod = 14) {
    const url = `${BASE_URL}/rsi?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: RSI ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      return parseFloat(data.values?.[0]?.rsi || 0);
    } catch (error) {
      console.error('Error fetching RSI:', error.message);
      throw error;
    }
  }

  async fetchMACD(symbol, interval) {
    const url = `${BASE_URL}/macd?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&fast_period=12&slow_period=26&signal_period=9`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: MACD ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      const latest = data.values?.[0] || {};
      return {
        macd: parseFloat(latest.macd || 0),
        signal: parseFloat(latest.macd_signal || 0),
        histogram: parseFloat(latest.macd_hist || 0)
      };
    } catch (error) {
      console.error('Error fetching MACD:', error.message);
      throw error;
    }
  }

  async fetchATR(symbol, interval, timePeriod = 14) {
    const url = `${BASE_URL}/atr?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      this.callCount++;
      console.log(`API Call #${this.callCount}: ATR ${symbol} ${interval}`);

      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }

      const val = parseFloat(data.values?.[0]?.atr);
      if (!isFinite(val)) throw new Error('ATR value missing or non-finite');
      return val;
    } catch (error) {
      console.error(`Error fetching ATR ${interval}:`, error.message);
      throw error;
    }
  }

  async fetchPrice(symbol) {
    const url = `${BASE_URL}/price?apikey=${API_KEY}&symbol=${symbol}`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      this.callCount++;

      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }

      return parseFloat(data.price);
    } catch (error) {
      console.error('Error fetching price:', error.message);
      throw error;
    }
  }

  // Compute ATR(period) from Twelve Data time_series values (newest-first array).
  // No extra API call — uses the OHLC already fetched by fetchTimeSeries.
  computeATR(values, period = 14) {
    if (!values || values.length < period + 1) return null;
    // Reverse to chronological order (oldest first)
    const candles = [...values].reverse();
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high = parseFloat(candles[i].high);
      const low = parseFloat(candles[i].low);
      const prevClose = parseFloat(candles[i - 1].close);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    const recent = trs.slice(-period);
    return recent.reduce((sum, v) => sum + v, 0) / recent.length;
  }

  async fetchAllIndicators(symbol, interval) {
    try {
      console.log(`\n📊 Fetching indicators for ${symbol} ${interval}...`);
      
      const [timeSeries, rsi, macd] = await Promise.all([
        this.fetchTimeSeries(symbol, interval, 2),
        this.fetchRSI(symbol, interval),
        this.fetchMACD(symbol, interval)
      ]);

      const latestCandle = timeSeries.values?.[0] || {};
      
      return {
        interval,
        price: parseFloat(latestCandle.close || 0),
        timestamp: latestCandle.datetime,
        rsi,
        macd: macd.macd,
        macd_signal: macd.signal,
        macd_hist: macd.histogram
      };
    } catch (error) {
      console.error(`Error fetching all indicators for ${interval}:`, error.message);
      throw error;
    }
  }

  async getMarketData(symbol = 'XAU/USD') {
    console.log('\n🚀 Starting market data fetch...\n');
    
    try {
      const [h4, h1, m30, m15] = await Promise.all([
        this.fetchAllIndicators(symbol, '4h'),
        this.fetchAllIndicators(symbol, '1h'),
        this.fetchAllIndicators(symbol, '30min'),
        this.fetchAllIndicators(symbol, '15min')
      ]);

      console.log(`\n✅ Market data fetched successfully`);
      console.log(`📞 Total API calls: ${this.callCount}`);
      
      return {
        symbol,
        timestamp: new Date().toISOString(),
        h4,
        h1,
        m30,
        m15,
        apiCallCount: this.callCount
      };
    } catch (error) {
      console.error('Error getting market data:', error.message);
      throw error;
    }
  }

  // 3-batch stagger — 17 calls/cycle spread so no 60-second window exceeds 8 calls.
  //
  // ATR sources:
  //   H1, M30 — API /atr primary, local OHLC fallback if API errors
  //   H4, M15, M5 — local OHLC only (no API call allocated)
  //
  // Batch timing vs 1-min price poller worst case:
  //   t=0   Batch A (7 calls)
  //   t=60  price poller (1 call)          ← 7+1 = 8 across [60,120)
  //   t=65  Batch B (7 calls)
  //   t=120 price poller (1 call)          ← 1+3 = 4 across [120,180)
  //   t=130 Batch C (3 calls)
  async getMarketDataStaggered(symbol = 'XAU/USD') {
    console.log('\n🚀 Starting staggered market data fetch (3 batches, 17 calls)...\n');
    this.resetCallCount();

    try {
      // === BATCH A (7 calls) — all time_series + RSI for H4 and H1 ===
      console.log('📞 Batch A/3: time_series×5 + RSI H4+H1 = 7 calls...');
      const batchA = await Promise.all([
        this.fetchTimeSeries(symbol, '4h',    50),  // [0]
        this.fetchTimeSeries(symbol, '1h',    50),  // [1]
        this.fetchTimeSeries(symbol, '30min', 50),  // [2]
        this.fetchTimeSeries(symbol, '15min', 50),  // [3]
        this.fetchTimeSeries(symbol, '5min',  50),  // [4]
        this.fetchRSI(symbol, '4h'),                // [5]
        this.fetchRSI(symbol, '1h')                 // [6]
      ]);
      console.log(`✅ Batch A complete (${this.callCount} calls)`);

      // Local ATR for all timeframes — computed from OHLC already in hand
      const localH4Atr  = this.computeATR(batchA[0].values);
      const localH1Atr  = this.computeATR(batchA[1].values);
      const localM30Atr = this.computeATR(batchA[2].values);
      const localM15Atr = this.computeATR(batchA[3].values);
      const localM5Atr  = this.computeATR(batchA[4].values);

      console.log('⏳ Waiting 65 s before batch B...');
      await new Promise(resolve => setTimeout(resolve, 65000));

      // === BATCH B (7 calls) — RSI M30+M15+M5, ATR H1+M30 (API), MACD H4+H1 ===
      console.log('📞 Batch B/3: RSI M30+M15+M5 + ATR H1+M30 + MACD H4+H1 = 7 calls...');
      const [rsiM30, rsiM15, rsiM5, h1AtrApi, m30AtrApi, macdH4, macdH1] = await Promise.all([
        this.fetchRSI(symbol, '30min'),
        this.fetchRSI(symbol, '15min'),
        this.fetchRSI(symbol, '5min'),
        this.fetchATR(symbol, '1h')
          .catch(e => { console.warn(`⚠️  H1 ATR API failed (${e.message}) — local fallback`); return null; }),
        this.fetchATR(symbol, '30min')
          .catch(e => { console.warn(`⚠️  M30 ATR API failed (${e.message}) — local fallback`); return null; }),
        this.fetchMACD(symbol, '4h'),
        this.fetchMACD(symbol, '1h')
      ]);
      console.log(`✅ Batch B complete (${this.callCount} calls)`);
      console.log(`📐 ATR — H1: ${h1AtrApi !== null ? 'API' : 'local'}, M30: ${m30AtrApi !== null ? 'API' : 'local'}`);

      console.log('⏳ Waiting 65 s before batch C...');
      await new Promise(resolve => setTimeout(resolve, 65000));

      // === BATCH C (3 calls) — MACD M30+M15+M5 ===
      console.log('📞 Batch C/3: MACD M30+M15+M5 = 3 calls...');
      const [macdM30, macdM15, macdM5] = await Promise.all([
        this.fetchMACD(symbol, '30min'),
        this.fetchMACD(symbol, '15min'),
        this.fetchMACD(symbol, '5min')
      ]);
      console.log(`✅ Batch C complete — ${this.callCount} total calls this cycle`);

      const result = {
        symbol,
        timestamp: new Date().toISOString(),
        h4: {
          interval: '4h',
          price: parseFloat(batchA[0].values?.[0]?.close || 0),
          timestamp: batchA[0].values?.[0]?.datetime,
          rsi: batchA[5],
          macd: macdH4.macd, macd_signal: macdH4.signal, macd_hist: macdH4.histogram,
          atr: localH4Atr           // local only
        },
        h1: {
          interval: '1h',
          price: parseFloat(batchA[1].values?.[0]?.close || 0),
          timestamp: batchA[1].values?.[0]?.datetime,
          rsi: batchA[6],
          macd: macdH1.macd, macd_signal: macdH1.signal, macd_hist: macdH1.histogram,
          atr: h1AtrApi ?? localH1Atr   // API primary, local fallback
        },
        m30: {
          interval: '30min',
          price: parseFloat(batchA[2].values?.[0]?.close || 0),
          timestamp: batchA[2].values?.[0]?.datetime,
          rsi: rsiM30,
          macd: macdM30.macd, macd_signal: macdM30.signal, macd_hist: macdM30.histogram,
          atr: m30AtrApi ?? localM30Atr // API primary, local fallback
        },
        m15: {
          interval: '15min',
          price: parseFloat(batchA[3].values?.[0]?.close || 0),
          timestamp: batchA[3].values?.[0]?.datetime,
          rsi: rsiM15,
          macd: macdM15.macd, macd_signal: macdM15.signal, macd_hist: macdM15.histogram,
          atr: localM15Atr           // local only
        },
        m5: {
          interval: '5min',
          price: parseFloat(batchA[4].values?.[0]?.close || 0),
          timestamp: batchA[4].values?.[0]?.datetime,
          rsi: rsiM5,
          macd: macdM5.macd, macd_signal: macdM5.signal, macd_hist: macdM5.histogram,
          atr: localM5Atr            // local only
        },
        apiCallCount: this.callCount
      };

      console.log(`📞 Total API calls this cycle: ${this.callCount}`);
      return result;
    } catch (error) {
      console.error('Error getting staggered market data:', error.message);
      throw error;
    }
  }

  resetCallCount() {
    this.callCount = 0;
    this.lastReset = new Date();
  }
}

export default new TwelveDataService();
