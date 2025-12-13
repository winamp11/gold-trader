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

  async fetchMFI(symbol, interval, timePeriod = 14) {
    const url = `${BASE_URL}/mfi?apikey=${API_KEY}&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}`;
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      this.callCount++;
      console.log(`API Call #${this.callCount}: MFI ${symbol} ${interval}`);
      
      if (data.status === 'error') {
        throw new Error(data.message || 'API error');
      }
      
      return parseFloat(data.values?.[0]?.mfi || 0);
    } catch (error) {
      console.error('Error fetching MFI:', error.message);
      throw error;
    }
  }

  async fetchAllIndicators(symbol, interval) {
    try {
      console.log(`\n📊 Fetching indicators for ${symbol} ${interval}...`);
      
      const [timeSeries, rsi, macd, mfi] = await Promise.all([
        this.fetchTimeSeries(symbol, interval, 2),
        this.fetchRSI(symbol, interval),
        this.fetchMACD(symbol, interval),
        this.fetchMFI(symbol, interval)
      ]);

      const latestCandle = timeSeries.values?.[0] || {};
      
      return {
        interval,
        price: parseFloat(latestCandle.close || 0),
        timestamp: latestCandle.datetime,
        rsi,
        macd: macd.macd,
        macd_signal: macd.signal,
        macd_hist: macd.histogram,
        mfi
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

  // Staggered version - splits 16 calls into 2 batches to stay under 8/min limit
  async getMarketDataStaggered(symbol = 'XAU/USD') {
    console.log('\n🚀 Starting staggered market data fetch (3-min process)...\n');
    this.resetCallCount();
    
    try {
      // BATCH 1: First 8 calls (time_series + RSI for all timeframes)
      console.log('📞 Batch 1/2: Fetching time_series & RSI (8 calls)...');
      const batch1 = await Promise.all([
        this.fetchTimeSeries(symbol, '4h', 50),
        this.fetchTimeSeries(symbol, '1h', 50),
        this.fetchTimeSeries(symbol, '30min', 50),
        this.fetchTimeSeries(symbol, '15min', 50),
        this.fetchRSI(symbol, '4h'),
        this.fetchRSI(symbol, '1h'),
        this.fetchRSI(symbol, '30min'),
        this.fetchRSI(symbol, '15min')
      ]);

      console.log(`✅ Batch 1 complete (${this.callCount} calls)`);
      console.log('⏳ Waiting 90 seconds before batch 2...');
      
      // Wait 1.5 minutes (90 seconds) before next batch
      await new Promise(resolve => setTimeout(resolve, 90000));

      // BATCH 2: Next 8 calls (MACD + MFI for all timeframes)
      console.log('📞 Batch 2/2: Fetching MACD & MFI (8 calls)...');
      const batch2 = await Promise.all([
        this.fetchMACD(symbol, '4h'),
        this.fetchMACD(symbol, '1h'),
        this.fetchMACD(symbol, '30min'),
        this.fetchMACD(symbol, '15min'),
        this.fetchMFI(symbol, '4h'),
        this.fetchMFI(symbol, '1h'),
        this.fetchMFI(symbol, '30min'),
        this.fetchMFI(symbol, '15min')
      ]);

      console.log(`✅ Batch 2 complete (${this.callCount} total calls)`);

      // Combine results
      const result = {
        symbol,
        timestamp: new Date().toISOString(),
        h4: {
          interval: '4h',
          price: parseFloat(batch1[0].values?.[0]?.close || 0),
          timestamp: batch1[0].values?.[0]?.datetime,
          rsi: batch1[4],
          macd: batch2[0].macd,
          macd_signal: batch2[0].signal,
          macd_hist: batch2[0].histogram,
          mfi: batch2[4]
        },
        h1: {
          interval: '1h',
          price: parseFloat(batch1[1].values?.[0]?.close || 0),
          timestamp: batch1[1].values?.[0]?.datetime,
          rsi: batch1[5],
          macd: batch2[1].macd,
          macd_signal: batch2[1].signal,
          macd_hist: batch2[1].histogram,
          mfi: batch2[5]
        },
        m30: {
          interval: '30min',
          price: parseFloat(batch1[2].values?.[0]?.close || 0),
          timestamp: batch1[2].values?.[0]?.datetime,
          rsi: batch1[6],
          macd: batch2[2].macd,
          macd_signal: batch2[2].signal,
          macd_hist: batch2[2].histogram,
          mfi: batch2[6]
        },
        m15: {
          interval: '15min',
          price: parseFloat(batch1[3].values?.[0]?.close || 0),
          timestamp: batch1[3].values?.[0]?.datetime,
          rsi: batch1[7],
          macd: batch2[3].macd,
          macd_signal: batch2[3].signal,
          macd_hist: batch2[3].histogram,
          mfi: batch2[7]
        },
        apiCallCount: this.callCount
      };

      console.log(`\n✅ Staggered market data fetch complete`);
      console.log(`📞 Total API calls: ${this.callCount}`);
      
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
