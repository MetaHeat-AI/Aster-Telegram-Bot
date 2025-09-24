import { PriceProtectionManager } from './priceguard';
import { FiltersManager } from './filters';
import { OrderBookDepth, UserSettings } from './types';
import fs from 'fs';

interface TestOrderBook {
  symbol: string;
  bids: [string, string][];
  asks: [string, string][];
  lastUpdateId: number;
}

class PriceGuardValidator {
  private filtersManager: FiltersManager;
  private priceProtection: PriceProtectionManager;
  private results: Array<{ test: string; status: 'PASS' | 'FAIL'; message: string }> = [];

  constructor() {
    this.filtersManager = new FiltersManager();
    this.priceProtection = new PriceProtectionManager(this.filtersManager);
    this.setupMockFilters();
  }

  private setupMockFilters(): void {
    // Mock BTCUSDT symbol filters for testing
    const mockSymbolInfo = {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      baseAsset: 'BTC',
      baseAssetPrecision: 8,
      quoteAsset: 'USDT',
      quotePrecision: 8,
      quoteAssetPrecision: 8,
      orderTypes: ['LIMIT', 'MARKET'],
      timeInForce: ['GTC', 'IOC', 'FOK'],
      filters: [
        {
          filterType: 'PRICE_FILTER',
          minPrice: '0.01',
          maxPrice: '1000000',
          tickSize: '0.01'
        },
        {
          filterType: 'LOT_SIZE',
          minQty: '0.00001',
          maxQty: '9000',
          stepSize: '0.00001'
        },
        {
          filterType: 'MIN_NOTIONAL',
          notional: '5.0'
        }
      ]
    };

    this.filtersManager.loadSymbolFilters(mockSymbolInfo as any);
  }

  private log(test: string, status: 'PASS' | 'FAIL', message: string): void {
    this.results.push({ test, status, message });
    const emoji = status === 'PASS' ? '✅' : '❌';
    console.log(`${emoji} ${test}: ${message}`);
  }

  private createTestOrderBook(scenario: string): TestOrderBook {
    switch (scenario) {
      case 'normal':
        return {
          symbol: 'BTCUSDT',
          lastUpdateId: 123456,
          bids: [
            ['50000.00', '1.5'],
            ['49999.50', '2.0'],
            ['49999.00', '1.0'],
            ['49998.50', '0.5'],
            ['49998.00', '3.0']
          ],
          asks: [
            ['50001.00', '1.2'],
            ['50001.50', '1.8'],
            ['50002.00', '2.5'],
            ['50002.50', '1.0'],
            ['50003.00', '0.8']
          ]
        };

      case 'low_liquidity':
        return {
          symbol: 'BTCUSDT',
          lastUpdateId: 123457,
          bids: [
            ['50000.00', '0.01'],
            ['49999.00', '0.01']
          ],
          asks: [
            ['50001.00', '0.01'],
            ['50002.00', '0.01']
          ]
        };

      case 'wide_spread':
        return {
          symbol: 'BTCUSDT',
          lastUpdateId: 123458,
          bids: [
            ['49000.00', '1.0'],
            ['48000.00', '2.0']
          ],
          asks: [
            ['51000.00', '1.0'],
            ['52000.00', '2.0']
          ]
        };

      case 'deep_liquidity':
        return {
          symbol: 'BTCUSDT',
          lastUpdateId: 123459,
          bids: Array.from({ length: 20 }, (_, i) => [
            (50000 - i * 0.5).toFixed(2),
            (10 + i).toString()
          ]) as [string, string][],
          asks: Array.from({ length: 20 }, (_, i) => [
            (50001 + i * 0.5).toFixed(2),
            (10 + i).toString()
          ]) as [string, string][]
        };

      default:
        throw new Error(`Unknown scenario: ${scenario}`);
    }
  }

  private createTestUserSettings(slippageBps: number = 50): UserSettings {
    return {
      user_id: 1,
      leverage_cap: 20,
      default_leverage: 3,
      size_presets: [50, 100, 250],
      slippage_bps: slippageBps,
      tp_presets: [2, 4, 8],
      sl_presets: [1, 2],
      daily_loss_cap: null,
      pin_hash: null
    };
  }

  async testNormalMarketConditions(): Promise<void> {
    console.log('\n🔸 Testing Normal Market Conditions...\n');

    const orderBook = this.createTestOrderBook('normal');
    const userSettings = this.createTestUserSettings(50); // 0.5% slippage tolerance

    try {
      // Test small buy order (should pass)
      const result1 = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        '0.1', // Small size
        orderBook,
        userSettings
      );

      if (result1.recommendation === 'EXECUTE' && !result1.requiresConfirmation) {
        this.log('Normal Conditions - Small Buy', 'PASS', 
          `Slippage: ${result1.slippageBps.toFixed(2)} bps, Impact: ${(result1.priceImpact * 100).toFixed(3)}%`);
      } else {
        this.log('Normal Conditions - Small Buy', 'FAIL', 
          `Unexpected result: ${result1.recommendation}, requires confirmation: ${result1.requiresConfirmation}`);
      }

      // Test medium buy order (may warn)
      const result2 = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        '1.0', // Medium size
        orderBook,
        userSettings
      );

      const acceptableResults = ['EXECUTE', 'WARNING'];
      if (acceptableResults.includes(result2.recommendation)) {
        this.log('Normal Conditions - Medium Buy', 'PASS', 
          `Slippage: ${result2.slippageBps.toFixed(2)} bps, Recommendation: ${result2.recommendation}`);
      } else {
        this.log('Normal Conditions - Medium Buy', 'FAIL', 
          `Unexpected recommendation: ${result2.recommendation}`);
      }

    } catch (error: any) {
      this.log('Normal Conditions Test', 'FAIL', `Error: ${error.message}`);
    }
  }

  async testLowLiquidityConditions(): Promise<void> {
    console.log('\n🔸 Testing Low Liquidity Conditions...\n');

    const orderBook = this.createTestOrderBook('low_liquidity');
    const userSettings = this.createTestUserSettings(50);

    try {
      // Test order larger than available liquidity
      const result = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        '1.0', // Larger than available
        orderBook,
        userSettings
      );

      if (result.recommendation === 'REJECT') {
        this.log('Low Liquidity - Insufficient Liquidity', 'PASS', 
          `Correctly rejected: ${result.warnings[0] || 'No warnings'}`);
      } else {
        this.log('Low Liquidity - Insufficient Liquidity', 'FAIL', 
          `Should have rejected, got: ${result.recommendation}`);
      }

    } catch (error: any) {
      if (error.message.includes('Insufficient liquidity')) {
        this.log('Low Liquidity Test', 'PASS', 'Correctly threw insufficient liquidity error');
      } else {
        this.log('Low Liquidity Test', 'FAIL', `Unexpected error: ${error.message}`);
      }
    }
  }

  async testWideSpreadConditions(): Promise<void> {
    console.log('\n🔸 Testing Wide Spread Conditions...\n');

    const orderBook = this.createTestOrderBook('wide_spread');
    const userSettings = this.createTestUserSettings(100); // 1% slippage tolerance

    try {
      const result = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        '0.5',
        orderBook,
        userSettings
      );

      // Wide spread should trigger warnings or rejection
      if (['WARNING', 'REJECT'].includes(result.recommendation)) {
        this.log('Wide Spread Test', 'PASS', 
          `Correctly flagged wide spread: ${result.recommendation}, Impact: ${(result.priceImpact * 100).toFixed(2)}%`);
      } else {
        this.log('Wide Spread Test', 'FAIL', 
          `Should have warned about wide spread, got: ${result.recommendation}`);
      }

    } catch (error: any) {
      this.log('Wide Spread Test', 'FAIL', `Error: ${error.message}`);
    }
  }

  async testSlippageThresholds(): Promise<void> {
    console.log('\n🔸 Testing Slippage Thresholds...\n');

    const orderBook = this.createTestOrderBook('normal');

    // Test with strict slippage tolerance
    const strictSettings = this.createTestUserSettings(10); // 0.1% very strict
    const lenientSettings = this.createTestUserSettings(500); // 5% very lenient

    try {
      // Same order with different slippage tolerances
      const strictResult = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        '2.0', // Large order
        orderBook,
        strictSettings
      );

      const lenientResult = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        '2.0', // Same large order
        orderBook,
        lenientSettings
      );

      // Strict should be more restrictive than lenient
      const strictnessOrder = ['EXECUTE', 'WARNING', 'REJECT'];
      const strictIndex = strictnessOrder.indexOf(strictResult.recommendation);
      const lenientIndex = strictnessOrder.indexOf(lenientResult.recommendation);

      if (strictIndex >= lenientIndex) {
        this.log('Slippage Threshold Test', 'PASS', 
          `Strict: ${strictResult.recommendation}, Lenient: ${lenientResult.recommendation}`);
      } else {
        this.log('Slippage Threshold Test', 'FAIL', 
          `Strict should be more restrictive. Strict: ${strictResult.recommendation}, Lenient: ${lenientResult.recommendation}`);
      }

    } catch (error: any) {
      this.log('Slippage Threshold Test', 'FAIL', `Error: ${error.message}`);
    }
  }

  async testOptimalOrderSize(): Promise<void> {
    console.log('\n🔸 Testing Optimal Order Size Calculation...\n');

    const orderBook = this.createTestOrderBook('deep_liquidity');
    const userSettings = this.createTestUserSettings(100); // 1% slippage

    try {
      const optimalSize = this.priceProtection.calculateOptimalOrderSize(
        'BTCUSDT',
        'BUY',
        100, // 1% max slippage in bps
        orderBook
      );

      const optimalSizeNum = parseFloat(optimalSize);
      
      if (optimalSizeNum > 0 && optimalSizeNum < 1000) {
        this.log('Optimal Order Size', 'PASS', 
          `Calculated optimal size: ${optimalSize} (reasonable range)`);
      } else {
        this.log('Optimal Order Size', 'FAIL', 
          `Optimal size seems unreasonable: ${optimalSize}`);
      }

      // Test that optimal size actually stays within slippage
      const testResult = await this.priceProtection.analyzeMarketOrder(
        'BTCUSDT',
        'BUY',
        optimalSize,
        orderBook,
        userSettings
      );

      if (testResult.slippageBps <= 100) { // Should be within 1%
        this.log('Optimal Size Validation', 'PASS', 
          `Optimal size stays within limits: ${testResult.slippageBps.toFixed(2)} bps`);
      } else {
        this.log('Optimal Size Validation', 'FAIL', 
          `Optimal size exceeds limits: ${testResult.slippageBps.toFixed(2)} bps`);
      }

    } catch (error: any) {
      this.log('Optimal Order Size Test', 'FAIL', `Error: ${error.message}`);
    }
  }

  async testMarketDepthAnalysis(): Promise<void> {
    console.log('\n🔸 Testing Market Depth Analysis...\n');

    const deepOrderBook = this.createTestOrderBook('deep_liquidity');
    const shallowOrderBook = this.createTestOrderBook('low_liquidity');

    try {
      const deepDepth = this.priceProtection.getMarketDepth(deepOrderBook, 'BUY');
      const shallowDepth = this.priceProtection.getMarketDepth(shallowOrderBook, 'BUY');

      // Deep market should have more levels and quantity
      const deepLevels = parseInt(deepDepth.levels.toString());
      const shallowLevels = parseInt(shallowDepth.levels.toString());
      
      if (deepLevels > shallowLevels) {
        this.log('Market Depth - Levels', 'PASS', 
          `Deep: ${deepLevels} levels, Shallow: ${shallowLevels} levels`);
      } else {
        this.log('Market Depth - Levels', 'FAIL', 
          `Deep market should have more levels. Deep: ${deepLevels}, Shallow: ${shallowLevels}`);
      }

      const deepQty = parseFloat(deepDepth.totalQuantity);
      const shallowQty = parseFloat(shallowDepth.totalQuantity);

      if (deepQty > shallowQty) {
        this.log('Market Depth - Quantity', 'PASS', 
          `Deep: ${deepQty}, Shallow: ${shallowQty}`);
      } else {
        this.log('Market Depth - Quantity', 'FAIL', 
          `Deep market should have more quantity. Deep: ${deepQty}, Shallow: ${shallowQty}`);
      }

    } catch (error: any) {
      this.log('Market Depth Analysis', 'FAIL', `Error: ${error.message}`);
    }
  }

  async testReasonableOrderSizeCheck(): Promise<void> {
    console.log('\n🔸 Testing Reasonable Order Size Check...\n');

    const orderBook = this.createTestOrderBook('normal');

    try {
      // Test small order (should be reasonable)
      const smallOrderCheck = this.priceProtection.isReasonableOrderSize(
        'BTCUSDT',
        '0.1',
        orderBook,
        'BUY'
      );

      if (smallOrderCheck.isReasonable) {
        this.log('Reasonable Size - Small Order', 'PASS', 
          `Small order reasonable: ${smallOrderCheck.percentOfDepth.toFixed(2)}% of depth`);
      } else {
        this.log('Reasonable Size - Small Order', 'FAIL', 
          `Small order should be reasonable: ${smallOrderCheck.recommendation}`);
      }

      // Test huge order (should be unreasonable)
      const hugeOrderCheck = this.priceProtection.isReasonableOrderSize(
        'BTCUSDT',
        '100',
        orderBook,
        'BUY'
      );

      if (!hugeOrderCheck.isReasonable) {
        this.log('Reasonable Size - Huge Order', 'PASS', 
          `Huge order correctly flagged: ${hugeOrderCheck.recommendation}`);
      } else {
        this.log('Reasonable Size - Huge Order', 'FAIL', 
          `Huge order should be flagged as unreasonable`);
      }

    } catch (error: any) {
      this.log('Reasonable Order Size Test', 'FAIL', `Error: ${error.message}`);
    }
  }

  async runAll(): Promise<void> {
    console.log('🛡️  Starting Price Protection Tests...\n');

    await this.testNormalMarketConditions();
    await this.testLowLiquidityConditions();
    await this.testWideSpreadConditions();
    await this.testSlippageThresholds();
    await this.testOptimalOrderSize();
    await this.testMarketDepthAnalysis();
    await this.testReasonableOrderSizeCheck();

    this.generateReport();
  }

  private generateReport(): void {
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const total = this.results.length;
    const passRate = ((passed / total) * 100).toFixed(1);

    console.log('\n📊 PRICE PROTECTION TEST RESULTS');
    console.log('==========================================');
    console.log(`✅ Passed: ${passed}/${total} (${passRate}%)`);
    console.log(`❌ Failed: ${total - passed}/${total}`);

    const allPassed = passed === total;
    const finalResult = allPassed ? 'PASS' : 'FAIL';
    
    console.log(`\n🎯 FINAL VERDICT: ${finalResult}`);

    if (allPassed) {
      console.log('✅ All price protection tests passed - system is working correctly');
    } else {
      console.log('❌ Some price protection tests failed - review implementation');
      
      const failures = this.results.filter(r => r.status === 'FAIL');
      console.log('\n❌ Failed Tests:');
      failures.forEach(f => {
        console.log(`  • ${f.test}: ${f.message}`);
      });
    }

    // Save results
    const report = {
      timestamp: new Date().toISOString(),
      finalResult,
      summary: { total, passed, failed: total - passed, passRate: parseFloat(passRate) },
      results: this.results
    };

    const reportPath = 'artifacts/priceguard_pass.txt';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Report saved to: ${reportPath}`);
  }
}

// Main execution
async function main() {
  const validator = new PriceGuardValidator();
  await validator.runAll();
}

if (require.main === module) {
  main().catch(console.error);
}

export { PriceGuardValidator };