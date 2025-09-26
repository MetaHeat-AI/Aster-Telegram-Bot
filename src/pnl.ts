import { AsterApiClient } from './aster';
import { SpotAccountService } from './services/SpotAccountService';
import { FuturesAccountService } from './services/FuturesAccountService';

interface Trade {
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  buyer: boolean;
  commission: string;
  commissionAsset: string;
  side: 'BUY' | 'SELL';
  realizedPnl?: string;
}

interface Position {
  asset: string;
  quantity: number;
  totalCost: number;
  avgPrice: number;
  trades: Trade[];
  unrealizedPnl: number;
  currentValue: number;
  pnlPercent: number;
}

export interface PnLResult {
  success: boolean;
  message: string;
  positions?: Position[];
  totalCostBasis?: number;
  totalCurrentValue?: number;
  totalUnrealizedPnL?: number;
  totalRealizedPnL?: number;
  totalPnL?: number;
  totalPnLPercent?: number;
  usdtBalance?: number;
  perpPositions?: any[];
  error?: any;
}

export class PnLCalculator {
  private apiClient: AsterApiClient;
  private spotAccountService: SpotAccountService;
  private futuresAccountService: FuturesAccountService;

  constructor(apiClient: AsterApiClient) {
    this.apiClient = apiClient;
    this.spotAccountService = new SpotAccountService(apiClient);
    this.futuresAccountService = new FuturesAccountService(apiClient);
  }

  async calculateComprehensivePnL(): Promise<PnLResult> {
    try {
      // Get both spot and futures positions
      const [spotResult, perpResult] = await Promise.all([
        this.calculateSpotPnL(),
        this.calculatePerpPnL()
      ]);

      if (!spotResult.success && !perpResult.success) {
        return {
          success: false,
          message: '❌ Failed to fetch both spot and futures data',
          error: 'Both API calls failed'
        };
      }

      // Combine results
      const totalUnrealizedPnL = (spotResult.totalUnrealizedPnL || 0) + (perpResult.totalUnrealizedPnL || 0);
      const totalRealizedPnL = (spotResult.totalRealizedPnL || 0) + (perpResult.totalRealizedPnL || 0);
      const totalPnL = totalUnrealizedPnL + totalRealizedPnL;
      const totalCostBasis = (spotResult.totalCostBasis || 0) + (perpResult.totalCostBasis || 0);
      const totalCurrentValue = (spotResult.totalCurrentValue || 0) + (perpResult.totalCurrentValue || 0);

      return {
        success: true,
        message: '✅ Comprehensive P&L calculated',
        positions: [...(spotResult.positions || []), ...(perpResult.positions || [])],
        perpPositions: perpResult.perpPositions || [],
        totalCostBasis,
        totalCurrentValue,
        totalUnrealizedPnL,
        totalRealizedPnL,
        totalPnL,
        totalPnLPercent: totalCostBasis > 0 ? (totalPnL / totalCostBasis * 100) : 0,
        usdtBalance: Math.max(spotResult.usdtBalance || 0, perpResult.usdtBalance || 0)
      };

    } catch (error) {
      return {
        success: false,
        message: `❌ Error calculating comprehensive P&L: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error
      };
    }
  }

  private async calculateSpotPnL(): Promise<PnLResult> {
    try {
      // Use SpotAccountService for better data handling
      const portfolioSummary = await this.spotAccountService.getPortfolioSummary();
      
      if (portfolioSummary.mainAssets.length === 0 && portfolioSummary.smallBalances.length === 0) {
        return {
          success: true,
          message: 'No spot assets found',
          positions: [],
          totalCostBasis: 0,
          totalCurrentValue: portfolioSummary.totalUsdValue,
          totalUnrealizedPnL: 0,
          totalRealizedPnL: 0,
          totalPnL: 0,
          totalPnLPercent: 0,
          usdtBalance: portfolioSummary.usdtBalance
        };
      }

      const positions: Position[] = [];
      const allAssets = [...portfolioSummary.mainAssets, ...portfolioSummary.smallBalances];

      // For spot trading, we need to calculate cost basis vs current value
      for (const balance of allAssets) {
        if (balance.asset === 'USDT') continue;

        const symbol = `${balance.asset}USDT`;
        
        try {
          // Get trades for this symbol to calculate cost basis
          const trades = await this.apiClient.getMyTrades(symbol);
          const validTrades = trades.filter(t => t.qty && t.price);

          let totalCostBasis = 0;
          let weightedAvgPrice = 0;

          if (validTrades.length > 0) {
            // Calculate weighted average cost using FIFO
            const { remainingCostBasis, weightedAvgPrice: avgPrice } = 
              this.calculateWeightedAverage(validTrades, balance.total);
            
            totalCostBasis = remainingCostBasis;
            weightedAvgPrice = avgPrice;
          } else {
            // If no trades found, use current value as cost basis (external transfer)
            totalCostBasis = balance.usdValue || 0;
            weightedAvgPrice = totalCostBasis / balance.total;
          }

          const currentValue = balance.usdValue || 0;
          const unrealizedPnl = currentValue - totalCostBasis;

          positions.push({
            asset: balance.asset,
            quantity: balance.total,
            totalCost: totalCostBasis,
            avgPrice: weightedAvgPrice,
            trades: validTrades,
            unrealizedPnl,
            currentValue,
            pnlPercent: totalCostBasis > 0 ? (unrealizedPnl / totalCostBasis * 100) : 0
          });

        } catch (error) {
          console.warn(`Failed to process ${symbol}:`, error);
          // Still add the position with zero cost basis
          positions.push({
            asset: balance.asset,
            quantity: balance.total,
            totalCost: 0,
            avgPrice: 0,
            trades: [],
            unrealizedPnl: balance.usdValue || 0,
            currentValue: balance.usdValue || 0,
            pnlPercent: 0
          });
        }
      }

      // Calculate totals
      const totalCostBasis = positions.reduce((sum, p) => sum + p.totalCost, 0);
      const totalCurrentValue = portfolioSummary.totalUsdValue;
      const totalUnrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

      return {
        success: true,
        message: '✅ Spot P&L calculated',
        positions,
        totalCostBasis,
        totalCurrentValue,
        totalUnrealizedPnL,
        totalRealizedPnL: 0, // Would need income history API
        totalPnL: totalUnrealizedPnL,
        totalPnLPercent: totalCostBasis > 0 ? (totalUnrealizedPnL / totalCostBasis * 100) : 0,
        usdtBalance: portfolioSummary.usdtBalance
      };

    } catch (error) {
      return {
        success: false,
        message: `❌ Error calculating spot P&L: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error
      };
    }
  }

  private async calculatePerpPnL(): Promise<PnLResult> {
    try {
      // Use FuturesAccountService for better data handling
      const portfolioSummary = await this.futuresAccountService.getPortfolioSummary();

      if (portfolioSummary.openPositions.length === 0) {
        return {
          success: true,
          message: 'No futures positions found',
          positions: [],
          perpPositions: [],
          totalCostBasis: 0,
          totalCurrentValue: portfolioSummary.totalWalletBalance,
          totalUnrealizedPnL: portfolioSummary.totalUnrealizedPnl,
          totalRealizedPnL: 0,
          totalPnL: portfolioSummary.totalUnrealizedPnl,
          totalPnLPercent: 0,
          usdtBalance: portfolioSummary.totalWalletBalance
        };
      }

      // Convert to PnL format
      const perpResults = portfolioSummary.openPositions.map(position => ({
        symbol: position.symbol,
        size: position.size,
        side: position.side,
        entryPrice: position.entryPrice,
        leverage: position.leverage,
        unrealizedPnl: position.unrealizedPnl,
        pnlPercent: position.pnlPercent
      }));

      return {
        success: true,
        message: '✅ Futures P&L calculated',
        positions: [],
        perpPositions: perpResults,
        totalCostBasis: 0, // For futures, margin is more relevant than cost basis
        totalCurrentValue: portfolioSummary.totalWalletBalance,
        totalUnrealizedPnL: portfolioSummary.totalUnrealizedPnl,
        totalRealizedPnL: 0, // Would need income history API
        totalPnL: portfolioSummary.totalUnrealizedPnl,
        totalPnLPercent: portfolioSummary.totalWalletBalance > 0 ? 
          (portfolioSummary.totalUnrealizedPnl / portfolioSummary.totalWalletBalance * 100) : 0,
        usdtBalance: portfolioSummary.totalWalletBalance
      };

    } catch (error) {
      return {
        success: false,
        message: `❌ Error calculating futures P&L: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error: error
      };
    }
  }

  private calculateWeightedAverage(trades: Trade[], currentAmount: number): {
    remainingQuantity: number;
    remainingCostBasis: number;
    weightedAvgPrice: number;
  } {
    let remainingQuantity = 0;
    let remainingCostBasis = 0;
    const sortedTrades = trades.sort((a, b) => a.time - b.time); // FIFO

    for (const trade of sortedTrades) {
      const qty = parseFloat(trade.qty);
      const price = parseFloat(trade.price);
      
      if (trade.side === 'BUY' || trade.buyer) {
        // Buy increases position
        remainingQuantity += qty;
        remainingCostBasis += qty * price;
      } else {
        // Sell decreases position (FIFO)
        const sellValue = qty * price;
        if (remainingQuantity > 0) {
          const costPerUnit = remainingCostBasis / remainingQuantity;
          const sellCost = Math.min(qty, remainingQuantity) * costPerUnit;
          remainingQuantity = Math.max(0, remainingQuantity - qty);
          remainingCostBasis = Math.max(0, remainingCostBasis - sellCost);
        }
      }
    }

    // Adjust to current actual balance (handles external transfers, etc.)
    if (remainingQuantity !== currentAmount && currentAmount > 0) {
      const ratio = currentAmount / remainingQuantity;
      remainingQuantity = currentAmount;
      remainingCostBasis *= ratio;
    }

    const weightedAvgPrice = remainingQuantity > 0 ? remainingCostBasis / remainingQuantity : 0;

    return {
      remainingQuantity,
      remainingCostBasis,
      weightedAvgPrice
    };
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const ticker = await this.apiClient.get24hrTicker(symbol);
      return parseFloat(ticker.lastPrice);
    } catch (error) {
      console.warn(`Failed to get price for ${symbol}:`, error);
      return 0;
    }
  }

  formatPnL(result: PnLResult): string {
    if (!result.success) {
      return result.message;
    }

    let output = '📊 **COMPREHENSIVE P&L ANALYSIS**\n';
    output += '═'.repeat(50) + '\n\n';

    // Portfolio Summary
    const totalPnL = result.totalPnL || 0;
    const totalPnLPercent = result.totalPnLPercent || 0;
    const pnlEmoji = totalPnL >= 0 ? '🟢' : '🔴';
    
    output += `💰 **Portfolio Value:** $${(result.totalCurrentValue || 0).toFixed(2)}\n`;
    output += `💵 **USDT Balance:** $${(result.usdtBalance || 0).toFixed(2)}\n`;
    output += `${pnlEmoji} **Total P&L:** ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} (${totalPnLPercent >= 0 ? '+' : ''}${totalPnLPercent.toFixed(1)}%)\n\n`;

    if (result.totalUnrealizedPnL !== undefined) {
      const urPnlEmoji = result.totalUnrealizedPnL >= 0 ? '🟢' : '🔴';
      output += `${urPnlEmoji} **Unrealized P&L:** ${result.totalUnrealizedPnL >= 0 ? '+' : ''}$${result.totalUnrealizedPnL.toFixed(2)}\n`;
    }

    if (result.totalRealizedPnL !== undefined && result.totalRealizedPnL !== 0) {
      const rPnlEmoji = result.totalRealizedPnL >= 0 ? '🟢' : '🔴';
      output += `${rPnlEmoji} **Realized P&L:** ${result.totalRealizedPnL >= 0 ? '+' : ''}$${result.totalRealizedPnL.toFixed(2)}\n`;
    }

    // Spot Positions
    if (result.positions && result.positions.length > 0) {
      output += '\n🏪 **SPOT POSITIONS**\n';
      output += '─'.repeat(50) + '\n';
      
      for (const position of result.positions) {
        const pnlEmoji = position.unrealizedPnl >= 0 ? '🟢' : '🔴';
        output += `**${position.asset}** | ${position.quantity.toFixed(4)} @ $${position.avgPrice.toFixed(4)}\n`;
        output += `${pnlEmoji} P&L: ${position.unrealizedPnl >= 0 ? '+' : ''}$${position.unrealizedPnl.toFixed(2)} (${position.pnlPercent >= 0 ? '+' : ''}${position.pnlPercent.toFixed(1)}%)\n\n`;
      }
    }

    // Futures Positions  
    if (result.perpPositions && result.perpPositions.length > 0) {
      output += '\n⚡ **FUTURES POSITIONS**\n';
      output += '─'.repeat(50) + '\n';
      
      for (const position of result.perpPositions) {
        const pnlEmoji = position.unrealizedPnl >= 0 ? '🟢' : '🔴';
        const sideEmoji = position.side === 'LONG' ? '🟢' : '🔴';
        output += `${sideEmoji} **${position.symbol}** ${position.side} ${position.leverage}x\n`;
        output += `Size: ${position.size.toFixed(4)} @ $${position.entryPrice.toFixed(4)}\n`;
        output += `${pnlEmoji} P&L: ${position.unrealizedPnl >= 0 ? '+' : ''}$${position.unrealizedPnl.toFixed(2)} (${position.pnlPercent >= 0 ? '+' : ''}${position.pnlPercent.toFixed(1)}%)\n\n`;
      }
    }

    output += '═'.repeat(50);
    return output;
  }
}