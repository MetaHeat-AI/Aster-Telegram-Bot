#!/usr/bin/env ts-node

import { TradeParser } from '../src/tradeparser';
import fs from 'fs';

interface FuzzTestCase {
  input: string;
  expected: 'PASS' | 'FAIL';
  description: string;
  expectedFields?: Partial<{
    action: 'BUY' | 'SELL';
    symbol: string;
    size: string;
    sizeType: 'BASE' | 'QUOTE';
    leverage: number;
    stopLoss: string;
    takeProfit: string;
  }>;
}

class TradeParserFuzzer {
  private testCases: FuzzTestCase[] = [];
  private results: Array<{ input: string; expected: string; actual: string; status: 'PASS' | 'FAIL'; errors?: string[] }> = [];

  constructor() {
    this.generateTestCases();
  }

  private generateTestCases(): void {
    // Valid cases - should PASS
    const validCases: FuzzTestCase[] = [
      // Basic buy/sell commands
      {
        input: '/buy BTCUSDT 100u x5 sl1% tp3%',
        expected: 'PASS',
        description: 'Standard buy command with quote size and risk management',
        expectedFields: {
          action: 'BUY',
          symbol: 'BTCUSDT',
          size: '100',
          sizeType: 'QUOTE',
          leverage: 5,
          stopLoss: '1',
          takeProfit: '3'
        }
      },
      {
        input: '/sell ETHUSDT 0.25 x3 reduce',
        expected: 'PASS',
        description: 'Sell command with base size and reduce-only',
        expectedFields: {
          action: 'SELL',
          symbol: 'ETHUSDT',
          size: '0.25',
          sizeType: 'BASE',
          leverage: 3
        }
      },
      {
        input: '/buy SOLUSDT mkt 250u tp2% trail1%',
        expected: 'PASS',
        description: 'Market buy with trailing stop',
        expectedFields: {
          action: 'BUY',
          symbol: 'SOLUSDT',
          size: '250',
          sizeType: 'QUOTE',
          takeProfit: '2'
        }
      },
      {
        input: '/sell ADAUSDT limit 1000u x2 sl2% tp5%',
        expected: 'PASS',
        description: 'Limit sell order',
        expectedFields: {
          action: 'SELL',
          symbol: 'ADAUSDT',
          size: '1000',
          sizeType: 'QUOTE',
          leverage: 2,
          stopLoss: '2',
          takeProfit: '5'
        }
      },
      {
        input: '/buy LINKUSDT 50u x10',
        expected: 'PASS',
        description: 'Simple buy with leverage only',
        expectedFields: {
          action: 'BUY',
          symbol: 'LINKUSDT',
          size: '50',
          sizeType: 'QUOTE',
          leverage: 10
        }
      },
      // Different symbol formats
      {
        input: '/buy BTC 100u x5',
        expected: 'PASS',
        description: 'Short symbol (should append USDT)',
        expectedFields: {
          action: 'BUY',
          symbol: 'BTCUSDT',
          size: '100',
          sizeType: 'QUOTE',
          leverage: 5
        }
      },
      {
        input: '/sell BTCUSD 0.1 x2',
        expected: 'PASS',
        description: 'USD quote currency',
        expectedFields: {
          action: 'SELL',
          symbol: 'BTCUSD',
          size: '0.1',
          sizeType: 'BASE',
          leverage: 2
        }
      },
      // Different size formats
      {
        input: '/buy BTCUSDT 100usdt x5',
        expected: 'PASS',
        description: 'Explicit USDT suffix',
        expectedFields: {
          action: 'BUY',
          symbol: 'BTCUSDT',
          size: '100',
          sizeType: 'QUOTE',
          leverage: 5
        }
      },
      {
        input: '/buy BTCUSDT 100 USDT x5',
        expected: 'PASS',
        description: 'Space separated USDT',
        expectedFields: {
          action: 'BUY',
          symbol: 'BTCUSDT',
          size: '100',
          sizeType: 'QUOTE',
          leverage: 5
        }
      },
      // Different leverage formats
      {
        input: '/buy BTCUSDT 100u leverage 5',
        expected: 'PASS',
        description: 'Verbose leverage format',
        expectedFields: { leverage: 5 }
      },
      {
        input: '/buy BTCUSDT 100u 5x',
        expected: 'PASS',
        description: 'Leverage with x suffix',
        expectedFields: { leverage: 5 }
      },
      // Different TP/SL formats
      {
        input: '/buy BTCUSDT 100u x5 stop loss 2% take profit 5%',
        expected: 'PASS',
        description: 'Verbose TP/SL format',
        expectedFields: {
          stopLoss: '2',
          takeProfit: '5'
        }
      },
      {
        input: '/buy BTCUSDT 100u x5 sl=1.5 tp=3.5',
        expected: 'PASS',
        description: 'Equal sign TP/SL format',
        expectedFields: {
          stopLoss: '1.5',
          takeProfit: '3.5'
        }
      },
      // Edge cases that should work
      {
        input: '/buy BTCUSDT 0.001 x1',
        expected: 'PASS',
        description: 'Minimum size with 1x leverage',
        expectedFields: {
          size: '0.001',
          sizeType: 'BASE',
          leverage: 1
        }
      },
      {
        input: '/sell BTCUSDT 10000u x20 sl0.1% tp0.2%',
        expected: 'PASS',
        description: 'Large size with fractional percentages',
        expectedFields: {
          size: '10000',
          leverage: 20,
          stopLoss: '0.1',
          takeProfit: '0.2'
        }
      }
    ];

    // Invalid cases - should FAIL
    const invalidCases: FuzzTestCase[] = [
      // Missing required fields
      {
        input: '/buy',
        expected: 'FAIL',
        description: 'Missing symbol and size'
      },
      {
        input: '/buy BTCUSDT',
        expected: 'FAIL',
        description: 'Missing size'
      },
      {
        input: '/trade BTCUSDT 100u',
        expected: 'FAIL',
        description: 'Invalid action (not buy/sell)'
      },
      // Invalid symbols
      {
        input: '/buy ??? 100u x5',
        expected: 'FAIL',
        description: 'Invalid symbol with special characters'
      },
      {
        input: '/buy A 100u x5',
        expected: 'FAIL',
        description: 'Too short symbol'
      },
      {
        input: '/buy VERYLONGSYMBOLNAME 100u x5',
        expected: 'FAIL',
        description: 'Excessively long symbol'
      },
      // Invalid sizes
      {
        input: '/buy BTCUSDT -100u x5',
        expected: 'FAIL',
        description: 'Negative size'
      },
      {
        input: '/buy BTCUSDT 0u x5',
        expected: 'FAIL',
        description: 'Zero size'
      },
      {
        input: '/buy BTCUSDT abcu x5',
        expected: 'FAIL',
        description: 'Non-numeric size'
      },
      // Invalid leverage
      {
        input: '/buy BTCUSDT 100u x0',
        expected: 'FAIL',
        description: 'Zero leverage'
      },
      {
        input: '/buy BTCUSDT 100u x-5',
        expected: 'FAIL',
        description: 'Negative leverage'
      },
      {
        input: '/buy BTCUSDT 100u x200',
        expected: 'FAIL',
        description: 'Excessive leverage (over 125)'
      },
      {
        input: '/buy BTCUSDT 100u xabc',
        expected: 'FAIL',
        description: 'Non-numeric leverage'
      },
      // Invalid percentages
      {
        input: '/buy BTCUSDT 100u x5 sl-1%',
        expected: 'FAIL',
        description: 'Negative stop loss'
      },
      {
        input: '/buy BTCUSDT 100u x5 tp0%',
        expected: 'FAIL',
        description: 'Zero take profit'
      },
      {
        input: '/buy BTCUSDT 100u x5 sl200%',
        expected: 'FAIL',
        description: 'Excessive stop loss percentage'
      },
      // Malformed commands
      {
        input: 'buy BTCUSDT 100u x5',
        expected: 'FAIL',
        description: 'Missing slash prefix'
      },
      {
        input: '/BUY BTCUSDT 100u x5',
        expected: 'FAIL',
        description: 'Incorrect case (should handle this gracefully)'
      },
      {
        input: '/buy / / /',
        expected: 'FAIL',
        description: 'Malformed with slashes'
      },
      {
        input: '/buy     ',
        expected: 'FAIL',
        description: 'Only whitespace after command'
      },
      // Unicode and special characters
      {
        input: '/buy BTCUSDT 100€ x5',
        expected: 'FAIL',
        description: 'Non-ASCII currency symbol'
      },
      {
        input: '/buy BTCUSDT 100u x5 sl1‰',
        expected: 'FAIL',
        description: 'Non-standard percentage symbol'
      },
      // Extremely long inputs
      {
        input: '/buy ' + 'A'.repeat(1000) + ' 100u x5',
        expected: 'FAIL',
        description: 'Extremely long symbol'
      },
      {
        input: '/buy BTCUSDT ' + '9'.repeat(100) + 'u x5',
        expected: 'FAIL',
        description: 'Extremely large size'
      }
    ];

    // Combine all test cases
    this.testCases = [...validCases, ...invalidCases];

    // Add some random fuzz cases
    this.generateRandomFuzzCases(50);
  }

  private generateRandomFuzzCases(count: number): void {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', '???', '', 'A'.repeat(20)];
    const sizes = ['100u', '0.25', '-50u', '0u', 'abcu', '999999999u'];
    const leverages = ['x5', 'x0', 'x-1', 'x200', 'xabc', ''];
    const actions = ['/buy', '/sell', '/trade', 'buy', ''];

    for (let i = 0; i < count; i++) {
      const action = actions[Math.floor(Math.random() * actions.length)];
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const size = sizes[Math.floor(Math.random() * sizes.length)];
      const leverage = leverages[Math.floor(Math.random() * leverages.length)];

      const input = [action, symbol, size, leverage].filter(x => x).join(' ');
      
      this.testCases.push({
        input,
        expected: 'FAIL', // Most random cases should fail
        description: `Random fuzz case ${i + 1}: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`
      });
    }
  }

  private runSingleTest(testCase: FuzzTestCase): void {
    try {
      const parseResult = TradeParser.parseTradeCommand(testCase.input);
      const actual = parseResult.success ? 'PASS' : 'FAIL';
      const status = actual === testCase.expected ? 'PASS' : 'FAIL';

      const result = {
        input: testCase.input,
        expected: testCase.expected,
        actual,
        status: status as 'PASS' | 'FAIL',
        errors: parseResult.success ? undefined : parseResult.errors
      };

      this.results.push(result);

      // Validate expected fields for passing tests
      if (testCase.expected === 'PASS' && parseResult.success && testCase.expectedFields) {
        const command = parseResult.command!;
        let fieldErrors: string[] = [];

        Object.entries(testCase.expectedFields).forEach(([field, expected]) => {
          const actualValue = (command as any)[field];
          if (actualValue !== expected) {
            fieldErrors.push(`${field}: expected ${expected}, got ${actualValue}`);
          }
        });

        if (fieldErrors.length > 0) {
          result.status = 'FAIL';
          result.errors = fieldErrors;
        }
      }

      // Log detailed results for failures
      if (result.status === 'FAIL') {
        console.log(`❌ FAIL: ${testCase.description}`);
        console.log(`   Input: "${testCase.input}"`);
        console.log(`   Expected: ${testCase.expected}, Got: ${actual}`);
        if (result.errors) {
          console.log(`   Errors: ${result.errors.join(', ')}`);
        }
      } else {
        console.log(`✅ PASS: ${testCase.description}`);
      }

    } catch (error: any) {
      const result = {
        input: testCase.input,
        expected: testCase.expected,
        actual: 'ERROR',
        status: 'FAIL' as 'PASS' | 'FAIL',
        errors: [`Exception: ${error.message}`]
      };
      
      this.results.push(result);
      console.log(`💥 ERROR: ${testCase.description} - ${error.message}`);
    }
  }

  public runAll(): void {
    console.log('🧨 Starting Trade Parser Fuzz Tests...\n');
    console.log(`Testing ${this.testCases.length} cases...\n`);

    // Group tests by type
    const validTests = this.testCases.filter(t => t.expected === 'PASS');
    const invalidTests = this.testCases.filter(t => t.expected === 'FAIL');

    console.log('🟢 Testing Valid Cases...\n');
    validTests.forEach(testCase => this.runSingleTest(testCase));

    console.log('\n🔴 Testing Invalid Cases...\n');
    invalidTests.forEach(testCase => this.runSingleTest(testCase));

    this.generateReport();
  }

  private generateReport(): void {
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const total = this.results.length;
    const passRate = ((passed / total) * 100).toFixed(1);

    const validCasePasses = this.results.filter(r => r.expected === 'PASS' && r.status === 'PASS').length;
    const validCaseTotal = this.results.filter(r => r.expected === 'PASS').length;
    const validCaseRate = validCaseTotal > 0 ? ((validCasePasses / validCaseTotal) * 100).toFixed(1) : '0';

    const invalidCasePasses = this.results.filter(r => r.expected === 'FAIL' && r.status === 'PASS').length;
    const invalidCaseTotal = this.results.filter(r => r.expected === 'FAIL').length;
    const invalidCaseRate = invalidCaseTotal > 0 ? ((invalidCasePasses / invalidCaseTotal) * 100).toFixed(1) : '0';

    console.log('\n📊 PARSER FUZZ TEST RESULTS');
    console.log('==========================================');
    console.log(`✅ Overall: ${passed}/${total} (${passRate}%)`);
    console.log(`🟢 Valid Cases: ${validCasePasses}/${validCaseTotal} (${validCaseRate}%)`);
    console.log(`🔴 Invalid Cases: ${invalidCasePasses}/${invalidCaseTotal} (${invalidCaseRate}%)`);

    // Failure analysis
    const failures = this.results.filter(r => r.status === 'FAIL');
    const failuresByType = {
      falsePositives: failures.filter(f => f.expected === 'FAIL' && f.actual === 'PASS'),
      falseNegatives: failures.filter(f => f.expected === 'PASS' && f.actual === 'FAIL'),
      exceptions: failures.filter(f => f.actual === 'ERROR')
    };

    console.log('\n🔍 Failure Analysis:');
    console.log(`False Positives (should fail but passed): ${failuresByType.falsePositives.length}`);
    console.log(`False Negatives (should pass but failed): ${failuresByType.falseNegatives.length}`);
    console.log(`Exceptions (parser crashed): ${failuresByType.exceptions.length}`);

    // Sample failures
    if (failuresByType.falseNegatives.length > 0) {
      console.log('\n❌ Sample False Negatives:');
      failuresByType.falseNegatives.slice(0, 5).forEach(f => {
        console.log(`  "${f.input}" - ${f.errors?.join(', ') || 'No error details'}`);
      });
    }

    if (failuresByType.falsePositives.length > 0) {
      console.log('\n⚠️  Sample False Positives:');
      failuresByType.falsePositives.slice(0, 5).forEach(f => {
        console.log(`  "${f.input}" - Should have been rejected`);
      });
    }

    // Save detailed report
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        total,
        passed,
        failed: total - passed,
        passRate: parseFloat(passRate),
        validCaseRate: parseFloat(validCaseRate),
        invalidCaseRate: parseFloat(invalidCaseRate)
      },
      failureAnalysis: {
        falsePositives: failuresByType.falsePositives.length,
        falseNegatives: failuresByType.falseNegatives.length,
        exceptions: failuresByType.exceptions.length
      },
      results: this.results.map(r => ({
        input: r.input,
        expected: r.expected,
        actual: r.actual,
        status: r.status,
        errors: r.errors
      })),
      sampleFailures: {
        falseNegatives: failuresByType.falseNegatives.slice(0, 10),
        falsePositives: failuresByType.falsePositives.slice(0, 10),
        exceptions: failuresByType.exceptions.slice(0, 5)
      }
    };

    const reportPath = 'artifacts/parser_fuzz_results.txt';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Detailed report saved to: ${reportPath}`);

    // Simple summary
    const isHealthy = passRate >= '90' && failuresByType.exceptions.length === 0;
    console.log(`\n🎯 PARSER HEALTH: ${isHealthy ? '✅ HEALTHY' : '⚠️  NEEDS ATTENTION'}`);
  }
}

// Main execution
async function main() {
  const fuzzer = new TradeParserFuzzer();
  fuzzer.runAll();
}

if (require.main === module) {
  main().catch(console.error);
}

export { TradeParserFuzzer };