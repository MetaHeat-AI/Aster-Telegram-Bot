import { AsterApiClient } from '../aster';
import { AccountInfo, PositionInfo } from '../types';

export interface FuturesPosition {
  symbol: string;
  side: 'LONG' | 'SHORT' | 'NONE';
  size: number;
  entryPrice: number;
  currentPrice?: number;
  leverage: number;
  unrealizedPnl: number;
  realTimeUnrealizedPnl?: number;
  pnlPercent: number;
  realTimePnlPercent?: number;
  notional: number;
  marginType: 'isolated' | 'cross';
  isolatedWallet?: number;
}

export interface FuturesPortfolioSummary {
  totalWalletBalance: number;
  availableBalance: number;
  totalUnrealizedPnl: number;
  totalMarginBalance: number;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  openPositions: FuturesPosition[];
  assets: Array<{
    asset: string;
    walletBalance: number;
    unrealizedPnl: number;
    availableBalance: number;
  }>;
}

export class FuturesAccountService {
  private apiClient: AsterApiClient;
  private lastTradeTime: number = 0;

  constructor(apiClient: AsterApiClient) {
    this.apiClient = apiClient;
  }

  // Call this method after executing a trade to record the time
  markTradeExecuted(): void {
    this.lastTradeTime = Date.now();
    console.log('[FuturesAccountService] Trade execution recorded');
  }

  // Add delay if a trade was recently executed
  private async addDelayIfNeeded(): Promise<void> {
    const timeSinceLastTrade = Date.now() - this.lastTradeTime;
    const POSITION_UPDATE_DELAY = 1500; // 1.5 seconds
    
    if (timeSinceLastTrade < POSITION_UPDATE_DELAY) {
      const delayNeeded = POSITION_UPDATE_DELAY - timeSinceLastTrade;
      console.log(`[FuturesAccountService] Adding ${delayNeeded}ms delay for position update after recent trade`);
      await new Promise(resolve => setTimeout(resolve, delayNeeded));
    }
  }

  async getFuturesAccount(): Promise<AccountInfo> {
    return await this.apiClient.getAccountInfo();
  }

  async getOpenPositions(): Promise<FuturesPosition[]> {
    try {
      // Add delay if a trade was recently executed
      await this.addDelayIfNeeded();
      
      const positions = await this.apiClient.getPositionRisk();
      const openPositions: FuturesPosition[] = [];

      // Get all symbols with open positions
      const openSymbols = positions
        .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
        .map(p => p.symbol);

      // Fetch current mark prices for all open positions
      let markPrices: { [symbol: string]: number } = {};
      if (openSymbols.length > 0) {
        try {
          const markPriceData = await this.apiClient.getMarkPrice();
          markPrices = markPriceData.reduce((acc, item) => {
            acc[item.symbol] = parseFloat(item.markPrice);
            return acc;
          }, {} as { [symbol: string]: number });
          console.log(`[FuturesAccountService] Fetched mark prices for ${Object.keys(markPrices).length} symbols`);
        } catch (error) {
          console.warn('[FuturesAccountService] Failed to fetch mark prices:', error);
        }
      }

      for (const position of positions) {
        const positionAmt = parseFloat(position.positionAmt);
        
        if (Math.abs(positionAmt) > 0) {
          const entryPrice = parseFloat(position.entryPrice);
          const leverage = parseFloat(position.leverage);
          const currentPrice = markPrices[position.symbol];
          
          // Parse unrealized PnL - handle potential undefined/empty values
          let unrealizedPnl = 0;
          if (position.unrealizedPnl && position.unrealizedPnl !== '' && position.unrealizedPnl !== '0') {
            unrealizedPnl = parseFloat(position.unrealizedPnl);
          }
          
          // Log raw PnL data for debugging
          console.log(`[FuturesAccountService] ${position.symbol} - Raw PnL: "${position.unrealizedPnl}", Parsed: ${unrealizedPnl}`);
          
          const notional = Math.abs(positionAmt * entryPrice);
          
          let side: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
          if (positionAmt > 0) side = 'LONG';
          else if (positionAmt < 0) side = 'SHORT';

          const pnlPercent = notional > 0 ? (unrealizedPnl / notional * 100) : 0;

          // Calculate real-time PnL if we have current price
          let realTimeUnrealizedPnl = unrealizedPnl;
          let realTimePnlPercent = pnlPercent;
          
          if (currentPrice && currentPrice > 0) {
            const direction = side === 'LONG' ? 1 : -1;
            const priceDiff = currentPrice - entryPrice;
            realTimeUnrealizedPnl = priceDiff * Math.abs(positionAmt) * direction;
            realTimePnlPercent = notional > 0 ? (realTimeUnrealizedPnl / notional * 100) : 0;
            
            console.log(`[FuturesAccountService] ${position.symbol} - Real-time PnL calculation: entry=${entryPrice}, current=${currentPrice}, diff=${priceDiff}, realTimePnL=${realTimeUnrealizedPnl}`);
          }

          openPositions.push({
            symbol: position.symbol,
            side,
            size: Math.abs(positionAmt),
            entryPrice,
            currentPrice,
            leverage,
            unrealizedPnl,
            realTimeUnrealizedPnl,
            pnlPercent,
            realTimePnlPercent,
            notional,
            marginType: position.isolated ? 'isolated' : 'cross',
            isolatedWallet: position.isolated ? parseFloat(position.isolatedWallet) : undefined
          });
        }
      }

      return openPositions.sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));
    } catch (error) {
      console.error('[FuturesAccountService] Failed to get open positions:', error);
      return [];
    }
  }

  async getPortfolioSummary(): Promise<FuturesPortfolioSummary> {
    try {
      const [account, positions] = await Promise.all([
        this.getFuturesAccount(),
        this.getOpenPositions()
      ]);

      const assets = account.assets.map(asset => ({
        asset: asset.asset,
        walletBalance: parseFloat(asset.walletBalance),
        unrealizedPnl: parseFloat(asset.unrealizedPnl),
        availableBalance: parseFloat(asset.availableBalance)
      }));

      return {
        totalWalletBalance: parseFloat(account.totalWalletBalance),
        availableBalance: parseFloat(account.availableBalance),
        totalUnrealizedPnl: parseFloat(account.totalUnrealizedPnl),
        totalMarginBalance: parseFloat(account.totalMarginBalance),
        totalPositionInitialMargin: account.totalPositionInitialMargin,
        totalOpenOrderInitialMargin: account.totalOpenOrderInitialMargin,
        openPositions: positions,
        assets
      };
    } catch (error) {
      console.error('[FuturesAccountService] Failed to get portfolio summary:', error);
      throw error;
    }
  }

  async getAvailableBalance(): Promise<number> {
    try {
      const account = await this.getFuturesAccount();
      return parseFloat(account.availableBalance);
    } catch (error) {
      console.error('[FuturesAccountService] Failed to get available balance:', error);
      return 0;
    }
  }

  async getPosition(symbol: string): Promise<FuturesPosition | null> {
    try {
      const positions = await this.getOpenPositions();
      return positions.find(p => p.symbol === symbol) || null;
    } catch (error) {
      console.error(`[FuturesAccountService] Failed to get position for ${symbol}:`, error);
      return null;
    }
  }

  formatFuturesPortfolio(summary: FuturesPortfolioSummary): string {
    let output = '\n⚡ **FUTURES** • $' + summary.totalWalletBalance.toFixed(2) + '\n';

    // Handle NaN values for PnL
    const pnlValue = isNaN(summary.totalUnrealizedPnl) ? 0 : summary.totalUnrealizedPnl;
    const pnlPercent = summary.totalWalletBalance > 0 && !isNaN(pnlValue) ? 
      (pnlValue / summary.totalWalletBalance * 100) : 0;

    // Compact status display
    if (summary.openPositions.length > 0) {
      const pnlEmoji = pnlValue >= 0 ? '📈' : '📉';
      output += `${pnlEmoji} P&L: ${pnlValue >= 0 ? '+' : ''}$${pnlValue.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)\n`;
      output += `📊 ${summary.openPositions.length} position${summary.openPositions.length > 1 ? 's' : ''} • $${summary.availableBalance.toFixed(2)} free\n`;
    } else {
      output += `💰 Available: $${summary.availableBalance.toFixed(2)}\n`;
      output += `📭 No positions • Ready to trade\n`;
    }

    // Show top 3 positions compactly if any exist
    if (summary.openPositions.length > 0) {
      summary.openPositions.slice(0, 3).forEach((position, index) => {
        const sideEmoji = position.side === 'LONG' ? '🟢' : '🔴';
        const currentPnl = position.realTimeUnrealizedPnl !== undefined ? position.realTimeUnrealizedPnl : position.unrealizedPnl;
        const currentPnlPercent = position.realTimePnlPercent !== undefined ? position.realTimePnlPercent : position.pnlPercent;
        const pnlEmoji = currentPnl >= 0 ? '📈' : '📉';
        
        output += `${sideEmoji} ${position.symbol} ${position.leverage}x ${pnlEmoji} ${currentPnl >= 0 ? '+' : ''}$${currentPnl.toFixed(2)}\n`;
      });
      
      if (summary.openPositions.length > 3) {
        output += `▫ +${summary.openPositions.length - 3} more positions\n`;
      }
    }

    return output;
  }
}