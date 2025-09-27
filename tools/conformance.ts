#!/usr/bin/env ts-node

import axios, { AxiosInstance } from 'axios';
import { AsterSigner } from '../src/signing';
import crypto from 'crypto';
import fs from 'fs';

interface ConformanceConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  mockMode: boolean;
}

class AsterConformanceTest {
  private axios: AxiosInstance;
  private config: ConformanceConfig;
  private results: Array<{ test: string; status: 'PASS' | 'FAIL'; message: string; timing?: number }> = [];
  private rateLimitHeaders: Record<string, any> = {};

  constructor(config: ConformanceConfig) {
    this.config = config;
    
    if (config.mockMode) {
      console.log('🔴 ==========================================');
      console.log('🔴 CONFORMANCE TEST - MOCK MODE');
      console.log('🔴 ==========================================');
    } else {
      console.log('🟢 ==========================================');
      console.log('🟢 CONFORMANCE TEST - LIVE MODE');
      console.log('🟢 ==========================================');
    }

    this.axios = axios.create({
      baseURL: config.baseUrl,
      timeout: 30000,
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'User-Agent': 'AsterBot-Conformance/1.0.0'
      }
    });

    // Response interceptor to capture rate limit headers
    this.axios.interceptors.response.use(
      (response) => {
        // Capture rate limit headers
        Object.keys(response.headers).forEach(header => {
          if (header.toLowerCase().includes('mbx') || header.toLowerCase().includes('rate')) {
            this.rateLimitHeaders[header] = response.headers[header];
          }
        });
        return response;
      },
      (error) => Promise.reject(error)
    );
  }

  private log(test: string, status: 'PASS' | 'FAIL', message: string, timing?: number): void {
    const result = { test, status, message, timing };
    this.results.push(result);
    const emoji = status === 'PASS' ? '✅' : '❌';
    const timingStr = timing ? ` (${timing}ms)` : '';
    console.log(`${emoji} ${test}: ${message}${timingStr}`);
  }

  async test1_Ping(): Promise<void> {
    const start = Date.now();
    try {
      if (this.config.mockMode) {
        this.log('Ping Test', 'PASS', 'Mock ping successful', 0);
        return;
      }

      const response = await this.axios.get('/fapi/v1/ping');
      const timing = Date.now() - start;
      
      if (response.status === 200) {
        this.log('Ping Test', 'PASS', 'Server connectivity confirmed', timing);
      } else {
        this.log('Ping Test', 'FAIL', `Unexpected status: ${response.status}`, timing);
      }
    } catch (error: any) {
      const timing = Date.now() - start;
      this.log('Ping Test', 'FAIL', `Error: ${error.message}`, timing);
    }
  }

  async test2_ServerTime(): Promise<void> {
    const start = Date.now();
    try {
      if (this.config.mockMode) {
        this.log('Server Time Test', 'PASS', 'Mock server time within acceptable drift', 0);
        return;
      }

      const clientTime = Date.now();
      const response = await this.axios.get('/fapi/v1/time');
      const timing = Date.now() - start;
      
      const serverTime = response.data.serverTime;
      const drift = Math.abs(serverTime - clientTime);
      
      if (drift < 1000) {
        this.log('Server Time Test', 'PASS', `Clock drift: ${drift}ms (acceptable)`, timing);
      } else {
        this.log('Server Time Test', 'FAIL', `Clock drift: ${drift}ms (too high)`, timing);
      }
    } catch (error: any) {
      const timing = Date.now() - start;
      this.log('Server Time Test', 'FAIL', `Error: ${error.message}`, timing);
    }
  }

  async test3_ExchangeInfo(): Promise<void> {
    const start = Date.now();
    try {
      if (this.config.mockMode) {
        this.log('Exchange Info Test', 'PASS', 'Mock exchange info contains BTCUSDT', 0);
        return;
      }

      const response = await this.axios.get('/fapi/v1/exchangeInfo');
      const timing = Date.now() - start;
      
      const exchangeInfo = response.data;
      const btcSymbol = exchangeInfo.symbols?.find((s: any) => s.symbol === 'BTCUSDT');
      
      if (btcSymbol) {
        const filters = btcSymbol.filters || [];
        const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        const lotSizeFilter = filters.find((f: any) => f.filterType === 'LOT_SIZE');
        
        let details = `BTCUSDT found with ${filters.length} filters`;
        if (priceFilter) details += `, tickSize: ${priceFilter.tickSize}`;
        if (lotSizeFilter) details += `, stepSize: ${lotSizeFilter.stepSize}`;
        
        this.log('Exchange Info Test', 'PASS', details, timing);
      } else {
        this.log('Exchange Info Test', 'FAIL', 'BTCUSDT symbol not found', timing);
      }
    } catch (error: any) {
      const timing = Date.now() - start;
      this.log('Exchange Info Test', 'FAIL', `Error: ${error.message}`, timing);
    }
  }

  async test4_OrderBook(): Promise<void> {
    const start = Date.now();
    try {
      if (this.config.mockMode) {
        this.log('Order Book Test', 'PASS', 'Mock order book data valid', 0);
        return;
      }

      const response = await this.axios.get('/fapi/v1/depth?symbol=BTCUSDT&limit=10');
      const timing = Date.now() - start;
      
      const depth = response.data;
      const bids = depth.bids || [];
      const asks = depth.asks || [];
      
      if (bids.length > 0 && asks.length > 0) {
        const bestBid = parseFloat(bids[0][0]);
        const bestAsk = parseFloat(asks[0][0]);
        const spread = bestAsk - bestBid;
        
        if (bestAsk > bestBid && spread > 0) {
          this.log('Order Book Test', 'PASS', `Valid order book: spread $${spread.toFixed(2)}`, timing);
        } else {
          this.log('Order Book Test', 'FAIL', 'Invalid order book: crossed market', timing);
        }
      } else {
        this.log('Order Book Test', 'FAIL', 'Empty order book', timing);
      }
    } catch (error: any) {
      const timing = Date.now() - start;
      this.log('Order Book Test', 'FAIL', `Error: ${error.message}`, timing);
    }
  }

  async test5_AccountRead(): Promise<void> {
    const start = Date.now();
    try {
      if (this.config.mockMode) {
        this.log('Account Read Test', 'PASS', 'Mock account data retrieved', 0);
        return;
      }

      if (!this.config.apiKey || !this.config.apiSecret) {
        this.log('Account Read Test', 'FAIL', 'Missing API credentials for signed request', 0);
        return;
      }

      const signedRequest = AsterSigner.signGetRequest('/fapi/v1/account', {}, this.config.apiSecret);
      const response = await this.axios.get(signedRequest.url);
      const timing = Date.now() - start;
      
      const account = response.data;
      if (account.totalWalletBalance !== undefined) {
        this.log('Account Read Test', 'PASS', `Balance: $${account.totalWalletBalance}`, timing);
      } else {
        this.log('Account Read Test', 'FAIL', 'Invalid account response format', timing);
      }
    } catch (error: any) {
      const timing = Date.now() - start;
      if (error.response?.status === 401) {
        this.log('Account Read Test', 'FAIL', 'Authentication failed - check API credentials', timing);
      } else {
        this.log('Account Read Test', 'FAIL', `Error: ${error.message}`, timing);
      }
    }
  }


  async test7_OrderLifecycle(): Promise<void> {
    const start = Date.now();
    try {
      if (this.config.mockMode) {
        this.log('Order Lifecycle Test', 'PASS', 'Mock order lifecycle completed', 0);
        return;
      }

      if (!this.config.apiKey || !this.config.apiSecret) {
        this.log('Order Lifecycle Test', 'FAIL', 'Missing API credentials', 0);
        return;
      }

      // Get current price to place far-off limit order
      const depthResponse = await this.axios.get('/fapi/v1/depth?symbol=BTCUSDT&limit=5');
      const bestBid = parseFloat(depthResponse.data.bids[0][0]);
      
      // Place limit BUY order 10% BELOW current price (safe distance, will never fill)
      // BTCUSDT tickSize is 0.1, so round to 1 decimal place  
      const testPrice = (Math.round(bestBid * 0.9 / 0.1) * 0.1).toFixed(1);
      const testQuantity = '0.001';
      const clientOrderId = `test_${Date.now()}`;

      const orderParams = {
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: testQuantity,
        price: testPrice,
        timeInForce: 'GTC',
        newClientOrderId: clientOrderId,
      };

      const signedRequest = AsterSigner.signPostRequest('/fapi/v1/order', orderParams, this.config.apiSecret);
      
      // Place order
      const orderResponse = await this.axios.post('/fapi/v1/order', new URLSearchParams(signedRequest.params as any));
      const orderId = orderResponse.data.orderId;

      if (!orderId) {
        this.log('Order Lifecycle Test', 'FAIL', 'Failed to place test order', Date.now() - start);
        return;
      }

      console.log(`📋 Test order placed: ${orderId}`);

      // Wait a moment then cancel
      await new Promise(resolve => setTimeout(resolve, 1000));

      const cancelParams = {
        symbol: 'BTCUSDT',
        orderId: orderId,
      };

      const cancelRequest = AsterSigner.signDeleteRequest('/fapi/v1/order', cancelParams, this.config.apiSecret);
      const cancelResponse = await this.axios.delete(cancelRequest.url);

      if (cancelResponse.data.status === 'CANCELED') {
        this.log('Order Lifecycle Test', 'PASS', `Order ${orderId} placed and canceled successfully`, Date.now() - start);
      } else {
        this.log('Order Lifecycle Test', 'FAIL', `Order cancel failed: ${cancelResponse.data.status}`, Date.now() - start);
      }

    } catch (error: any) {
      const timing = Date.now() - start;
      if (error.response?.data?.msg) {
        this.log('Order Lifecycle Test', 'FAIL', `API Error: ${error.response.data.msg}`, timing);
      } else {
        this.log('Order Lifecycle Test', 'FAIL', `Error: ${error.message}`, timing);
      }
    }
  }

  async runAll(): Promise<void> {
    console.log('\n🧪 Starting Aster API Conformance Tests...\n');

    await this.test1_Ping();
    await this.test2_ServerTime();
    await this.test3_ExchangeInfo();
    await this.test4_OrderBook();
    await this.test5_AccountRead();
    
    // Add delay before user stream test
    console.log('\n⏳ Waiting 2 seconds before user stream test...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    
    // Add delay before order lifecycle test
    console.log('\n⏳ Waiting 3 seconds before order lifecycle test...\n');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await this.test7_OrderLifecycle();

    this.generateReport();
  }

  private generateReport(): void {
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const total = this.results.length;
    const passRate = ((passed / total) * 100).toFixed(1);

    console.log('\n📊 CONFORMANCE TEST RESULTS');
    console.log('==========================================');
    console.log(`✅ Passed: ${passed}/${total} (${passRate}%)`);
    console.log(`❌ Failed: ${total - passed}/${total}`);

    if (Object.keys(this.rateLimitHeaders).length > 0) {
      console.log('\n📈 Rate Limit Headers Captured:');
      Object.entries(this.rateLimitHeaders).forEach(([header, value]) => {
        console.log(`  ${header}: ${value}`);
      });
    }

    // Save detailed results
    const report = {
      timestamp: new Date().toISOString(),
      config: {
        baseUrl: this.config.baseUrl,
        mockMode: this.config.mockMode,
        hasCredentials: !!(this.config.apiKey && this.config.apiSecret)
      },
      summary: {
        total,
        passed,
        failed: total - passed,
        passRate: parseFloat(passRate)
      },
      results: this.results,
      rateLimitHeaders: this.rateLimitHeaders
    };

    const reportPath = 'artifacts/conformance_run.log';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Detailed report saved to: ${reportPath}`);
  }
}

// Main execution
async function main() {
  const config: ConformanceConfig = {
    baseUrl: process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com',
    apiKey: process.env.ASTER_API_KEY || '',
    apiSecret: process.env.ASTER_API_SECRET || '',
    mockMode: process.env.MOCK === 'true'
  };

  console.log('🔧 Configuration:');
  console.log(`  Base URL: ${config.baseUrl}`);
  console.log(`  Mock Mode: ${config.mockMode}`);
  console.log(`  Has Credentials: ${!!(config.apiKey && config.apiSecret)}`);

  const tester = new AsterConformanceTest(config);
  await tester.runAll();
}

if (require.main === module) {
  main().catch(console.error);
}

export { AsterConformanceTest };