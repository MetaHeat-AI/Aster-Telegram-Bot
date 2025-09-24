import { OrderBookDepth, UserSettings } from './types';
import { FiltersManager, PriceImpactResult } from './filters';
import { PriceUtils } from './filters';

export interface PriceProtectionResult {
  isProtected: boolean;
  estimatedPrice: string;
  maxPrice: string;
  minPrice: string;
  priceImpact: number;
  slippageBps: number;
  recommendation: 'EXECUTE' | 'WARNING' | 'REJECT';
  warnings: string[];
  requiresConfirmation: boolean;
}

export interface MarketOrderAnalysis {
  side: 'BUY' | 'SELL';
  quantity: string;
  estimatedFillPrice: string;
  totalCost: string;
  averagePrice: string;
  priceImpact: number;
  slippageBps: number;
  liquidityDepth: number;
  partialFillRisk: boolean;
}

export class PriceProtectionManager {
  private filtersManager: FiltersManager;

  constructor(filtersManager: FiltersManager) {
    this.filtersManager = filtersManager;
  }

  // Main price protection check for market orders
  async analyzeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    orderBook: OrderBookDepth,
    userSettings: UserSettings
  ): Promise<PriceProtectionResult> {
    try {
      const analysis = await this.analyzeOrderExecution(symbol, side, quantity, orderBook);
      const protection = this.evaluateProtection(analysis, userSettings);
      
      return protection;
    } catch (error) {
      return {
        isProtected: true,
        estimatedPrice: '0',
        maxPrice: '0',
        minPrice: '0',
        priceImpact: 0,
        slippageBps: 0,
        recommendation: 'REJECT',
        warnings: [`Price protection failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        requiresConfirmation: false,
      };
    }
  }

  // Analyze how a market order would execute
  private async analyzeOrderExecution(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    orderBook: OrderBookDepth
  ): Promise<MarketOrderAnalysis> {
    const orders = side === 'BUY' ? orderBook.asks : orderBook.bids;
    
    if (orders.length === 0) {
      throw new Error('Empty order book - no liquidity available');
    }

    const targetQty = parseFloat(quantity);
    let remainingQty = targetQty;
    let totalCost = 0;
    let totalQuantityFilled = 0;
    let worstPrice = 0;
    let liquidityDepth = 0;

    // Simulate order execution
    for (const [priceStr, qtyStr] of orders) {
      if (remainingQty <= 0) break;

      const price = parseFloat(priceStr);
      const availableQty = parseFloat(qtyStr);
      const fillQty = Math.min(remainingQty, availableQty);

      if (side === 'BUY') {
        totalCost += fillQty * price;
      } else {
        totalCost += fillQty * price;
      }

      totalQuantityFilled += fillQty;
      remainingQty -= fillQty;
      worstPrice = price;
      liquidityDepth++;
    }

    const bestPrice = parseFloat(orders[0][0]);
    const averagePrice = totalQuantityFilled > 0 ? totalCost / totalQuantityFilled : bestPrice;
    const priceImpact = Math.abs(averagePrice - bestPrice) / bestPrice;
    const slippageBps = priceImpact * 10000;

    return {
      side,
      quantity,
      estimatedFillPrice: worstPrice.toString(),
      totalCost: totalCost.toString(),
      averagePrice: averagePrice.toString(),
      priceImpact,
      slippageBps,
      liquidityDepth,
      partialFillRisk: remainingQty > 0,
    };
  }

  // Evaluate protection level based on analysis and user settings
  private evaluateProtection(
    analysis: MarketOrderAnalysis,
    userSettings: UserSettings
  ): PriceProtectionResult {
    const warnings: string[] = [];
    let recommendation: 'EXECUTE' | 'WARNING' | 'REJECT' = 'EXECUTE';
    let requiresConfirmation = false;

    const maxSlippageBps = userSettings.slippage_bps;
    const actualSlippageBps = analysis.slippageBps;

    // Check slippage thresholds
    if (actualSlippageBps > maxSlippageBps) {
      if (actualSlippageBps > maxSlippageBps * 2) {
        recommendation = 'REJECT';
        warnings.push(
          `Excessive slippage: ${actualSlippageBps.toFixed(2)} bps exceeds maximum ${maxSlippageBps} bps`
        );
      } else {
        recommendation = 'WARNING';
        requiresConfirmation = true;
        warnings.push(
          `High slippage warning: ${actualSlippageBps.toFixed(2)} bps exceeds preferred ${maxSlippageBps} bps`
        );
      }
    }

    // Check price impact thresholds
    if (analysis.priceImpact > 0.01) { // 1% price impact
      if (analysis.priceImpact > 0.05) { // 5% price impact
        recommendation = 'REJECT';
        warnings.push(
          `Excessive price impact: ${(analysis.priceImpact * 100).toFixed(2)}% may indicate market manipulation`
        );
      } else {
        if (recommendation !== 'REJECT') {
          recommendation = 'WARNING';
          requiresConfirmation = true;
        }
        warnings.push(
          `High price impact: ${(analysis.priceImpact * 100).toFixed(2)}% - consider reducing order size`
        );
      }
    }

    // Check liquidity depth
    if (analysis.liquidityDepth <= 2) {
      if (recommendation !== 'REJECT') {
        recommendation = 'WARNING';
        requiresConfirmation = true;
      }
      warnings.push(
        `Low liquidity: order would consume ${analysis.liquidityDepth} price level(s)`
      );
    }

    // Check for partial fill risk
    if (analysis.partialFillRisk) {
      recommendation = 'REJECT';
      warnings.push('Insufficient liquidity - order cannot be fully filled');
    }

    // Calculate price bounds
    const estimatedPrice = parseFloat(analysis.averagePrice);
    const slippageFactor = Math.max(actualSlippageBps, maxSlippageBps) / 10000;
    
    let maxPrice: string, minPrice: string;
    if (analysis.side === 'BUY') {
      maxPrice = PriceUtils.formatPrice(estimatedPrice * (1 + slippageFactor));
      minPrice = PriceUtils.formatPrice(estimatedPrice);
    } else {
      maxPrice = PriceUtils.formatPrice(estimatedPrice);
      minPrice = PriceUtils.formatPrice(estimatedPrice * (1 - slippageFactor));
    }

    return {
      isProtected: recommendation !== 'EXECUTE',
      estimatedPrice: analysis.averagePrice,
      maxPrice,
      minPrice,
      priceImpact: analysis.priceImpact,
      slippageBps: actualSlippageBps,
      recommendation,
      warnings,
      requiresConfirmation,
    };
  }

  // Calculate optimal order size to stay within slippage limits
  calculateOptimalOrderSize(
    symbol: string,
    side: 'BUY' | 'SELL',
    maxSlippageBps: number,
    orderBook: OrderBookDepth
  ): string {
    const orders = side === 'BUY' ? orderBook.asks : orderBook.bids;
    
    if (orders.length === 0) {
      return '0';
    }

    const bestPrice = parseFloat(orders[0][0]);
    const maxSlippage = maxSlippageBps / 10000;
    const maxAcceptablePrice = bestPrice * (1 + maxSlippage);
    
    let totalQuantity = 0;
    
    for (const [priceStr, qtyStr] of orders) {
      const price = parseFloat(priceStr);
      const quantity = parseFloat(qtyStr);
      
      if (side === 'BUY' && price > maxAcceptablePrice) break;
      if (side === 'SELL' && price < bestPrice * (1 - maxSlippage)) break;
      
      totalQuantity += quantity;
    }
    
    const filters = this.filtersManager.getSymbolFilters(symbol);
    if (filters) {
      return filters.roundQuantity(totalQuantity);
    }
    
    return totalQuantity.toString();
  }

  // Get market depth statistics
  getMarketDepth(orderBook: OrderBookDepth, side: 'BUY' | 'SELL'): {
    levels: number;
    totalQuantity: string;
    averageOrderSize: string;
    spread: string;
    spreadBps: number;
  } {
    const orders = side === 'BUY' ? orderBook.asks : orderBook.bids;
    const oppositeOrders = side === 'BUY' ? orderBook.bids : orderBook.asks;
    
    if (orders.length === 0 || oppositeOrders.length === 0) {
      return {
        levels: 0,
        totalQuantity: '0',
        averageOrderSize: '0',
        spread: '0',
        spreadBps: 0,
      };
    }

    const totalQuantity = orders.reduce((sum, [, qtyStr]) => sum + parseFloat(qtyStr), 0);
    const averageOrderSize = totalQuantity / orders.length;
    
    const bestBid = parseFloat(orderBook.bids[0][0]);
    const bestAsk = parseFloat(orderBook.asks[0][0]);
    const spread = bestAsk - bestBid;
    const spreadBps = (spread / bestBid) * 10000;

    return {
      levels: orders.length,
      totalQuantity: totalQuantity.toString(),
      averageOrderSize: averageOrderSize.toString(),
      spread: spread.toString(),
      spreadBps,
    };
  }

  // Check if order size is reasonable relative to market
  isReasonableOrderSize(
    symbol: string,
    quantity: string,
    orderBook: OrderBookDepth,
    side: 'BUY' | 'SELL'
  ): {
    isReasonable: boolean;
    percentOfDepth: number;
    recommendation: string;
  } {
    const marketDepth = this.getMarketDepth(orderBook, side);
    const orderQuantity = parseFloat(quantity);
    const totalDepth = parseFloat(marketDepth.totalQuantity);
    
    if (totalDepth === 0) {
      return {
        isReasonable: false,
        percentOfDepth: 100,
        recommendation: 'No liquidity available',
      };
    }

    const percentOfDepth = (orderQuantity / totalDepth) * 100;

    let isReasonable = true;
    let recommendation = 'Order size looks good';

    if (percentOfDepth > 50) {
      isReasonable = false;
      recommendation = 'Order too large - would consume >50% of available liquidity';
    } else if (percentOfDepth > 25) {
      isReasonable = false;
      recommendation = 'Order size is large - consider splitting into smaller orders';
    } else if (percentOfDepth > 10) {
      recommendation = 'Moderate order size - monitor for slippage';
    }

    return {
      isReasonable,
      percentOfDepth,
      recommendation,
    };
  }

  // Generate user-friendly protection summary
  generateProtectionSummary(result: PriceProtectionResult): string {
    const lines: string[] = [];
    
    lines.push(`💰 Estimated Price: ${result.estimatedPrice}`);
    lines.push(`📊 Price Impact: ${(result.priceImpact * 100).toFixed(2)}%`);
    lines.push(`📈 Slippage: ${result.slippageBps.toFixed(1)} bps`);
    
    if (result.warnings.length > 0) {
      lines.push('\n⚠️ Warnings:');
      result.warnings.forEach(warning => {
        lines.push(`• ${warning}`);
      });
    }

    let emoji = '✅';
    let statusText = 'Order looks good';

    switch (result.recommendation) {
      case 'WARNING':
        emoji = '⚠️';
        statusText = 'Proceed with caution';
        break;
      case 'REJECT':
        emoji = '❌';
        statusText = 'Order not recommended';
        break;
    }

    lines.unshift(`${emoji} ${statusText}`);

    return lines.join('\n');
  }
}