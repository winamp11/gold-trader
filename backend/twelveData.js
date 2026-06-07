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

  // Single bulk POST to /complex_data — 1 API call for all 5 methods × 5 intervals.
  // Response is a flat array of 25 items ordered: method-group, then interval within each group.
  // ATR: API value primary, local OHLC fallback if absent.
  // ADX: returned for all intervals; callers use h4/h1/m30 only.
  async getMarketDataBulk(symbol = 'XAU/USD') {
    console.log('\n🚀 Starting bulk complex_data fetch (1 POST, 25 items)...\n');
    this.resetCallCount();

    const payload = {
      symbol,
      methods: [
        { name: 'time_series', params: { outputsize: 20 } },
        { name: 'rsi',         params: { time_period: 14 } },
        { name: 'macd',        params: { fast_period: 12, slow_period: 26, signal_period: 9 } },
        { name: 'atr',         params: { time_period: 14 } },
        { name: 'adx',         params: { time_period: 14 } },
      ],
      intervals: ['4h', '1h', '30min', '15min', '5min'],
    };

    try {
      const response = await fetch(
        `${BASE_URL}/complex_data?apikey=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      const raw = await response.json();
      this.callCount++;
      console.log(`✅ complex_data POST returned ${raw.data?.length ?? 0} items`);

      if (raw.status === 'error') {
        throw new Error(raw.message || 'complex_data API error');
      }

      // Classify each item by its indicator name prefix
      function indicatorKey(item) {
        const name = item.meta?.indicator?.name ?? '';
        if (!name)                  return 'ts';
        if (name.startsWith('RSI'))  return 'rsi';
        if (name.startsWith('MACD')) return 'macd';
        if (name.startsWith('ATR'))  return 'atr';
        if (name.startsWith('ADX'))  return 'adx';
        return null;
      }

      // Group latest values: grouped[`${interval}:${key}`] = values[0]
      // Keep full OHLC arrays for local ATR fallback
      const grouped = {};
      const ohlc    = {};

      for (const item of raw.data) {
        const interval = item.meta?.interval;
        const key      = indicatorKey(item);
        if (!interval || key === null) continue;
        if (key === 'ts') ohlc[interval] = item.values;
        grouped[`${interval}:${key}`] = item.values?.[0] ?? null;
      }

      const f = (v, fallback = null) => { const n = parseFloat(v); return isFinite(n) ? n : fallback; };

      const buildTf = (interval) => {
        const ts   = grouped[`${interval}:ts`]   ?? {};
        const rsi  = grouped[`${interval}:rsi`]  ?? {};
        const macd = grouped[`${interval}:macd`] ?? {};
        const atr  = grouped[`${interval}:atr`]  ?? {};
        const adx  = grouped[`${interval}:adx`]  ?? {};
        const atrVal = f(atr.atr) ?? this.computeATR(ohlc[interval]);
        return {
          interval,
          price:       f(ts.close, 0),
          timestamp:   ts.datetime  ?? null,
          rsi:         f(rsi.rsi),
          macd:        f(macd.macd),
          macd_signal: f(macd.macd_signal),
          macd_hist:   f(macd.macd_hist),
          atr:         atrVal,
          adx:         f(adx.adx),
        };
      };

      const h4  = buildTf('4h');
      const h1  = buildTf('1h');
      const m30 = buildTf('30min');
      const m15 = buildTf('15min');
      const m5  = buildTf('5min');

      console.log(`📐 ADX — H4: ${h4.adx?.toFixed(1)}, H1: ${h1.adx?.toFixed(1)}, M30: ${m30.adx?.toFixed(1)}`);
      console.log(`📞 Total API calls this cycle: ${this.callCount}`);

      return { symbol, timestamp: new Date().toISOString(), h4, h1, m30, m15, m5, apiCallCount: this.callCount };
    } catch (error) {
      console.error('Error in getMarketDataBulk:', error.message);
      throw error;
    }
  }

  resetCallCount() {
    this.callCount = 0;
    this.lastReset = new Date();
  }
}

export default new TwelveDataService();
