import { AsterApiClient } from '../aster';
import { AccountInfo, PositionInfo } from '../types';

export interface FuturesPosition {
  symbol: string;
  side: 'LONG' | 'SHORT' | 'NONE';
  size: number;
  entryPrice: number;
  leverage: number;
  unrealizedPnl: number;
  pnlPercent: number;
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

  constructor(apiClient: AsterApiClient) {
    this.apiClient = apiClient;
  }

  async getFuturesAccount(): Promise<AccountInfo> {
    return await this.apiClient.getAccountInfo();
  }

  async getOpenPositions(): Promise<FuturesPosition[]> {
    try {
      const positions = await this.apiClient.getPositionRisk();
      const openPositions: FuturesPosition[] = [];

      for (const position of positions) {
        const positionAmt = parseFloat(position.positionAmt);
        
        if (Math.abs(positionAmt) > 0) {
          const entryPrice = parseFloat(position.entryPrice);
          const leverage = parseFloat(position.leverage);
          const unrealizedPnl = parseFloat(position.unrealizedPnl);
          const notional = Math.abs(positionAmt * entryPrice);
          
          let side: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
          if (positionAmt > 0) side = 'LONG';
          else if (positionAmt < 0) side = 'SHORT';

          const pnlPercent = notional > 0 ? (unrealizedPnl / notional * 100) : 0;

          openPositions.push({
            symbol: position.symbol,
            side,
            size: Math.abs(positionAmt),
            entryPrice,
            leverage,
            unrealizedPnl,
            pnlPercent,
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
    let output = '⚡ **FUTURES PORTFOLIO**\n';
    output += '═'.repeat(40) + '\n\n';

    // Account overview
    const pnlEmoji = summary.totalUnrealizedPnl >= 0 ? '🟢' : '🔴';
    const pnlPercent = summary.totalWalletBalance > 0 ? 
      (summary.totalUnrealizedPnl / summary.totalWalletBalance * 100) : 0;

    output += `💰 **Total Wallet:** $${summary.totalWalletBalance.toFixed(2)}\n`;
    output += `💵 **Available:** $${summary.availableBalance.toFixed(2)}\n`;
    output += `${pnlEmoji} **Unrealized PnL:** ${summary.totalUnrealizedPnl >= 0 ? '+' : ''}$${summary.totalUnrealizedPnl.toFixed(2)}`;
    output += ` (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n`;
    output += `📊 **Margin Balance:** $${summary.totalMarginBalance.toFixed(2)}\n\n`;

    // Open positions
    if (summary.openPositions.length > 0) {
      output += '**📈 OPEN POSITIONS:**\n';
      
      summary.openPositions.forEach(position => {
        const sideEmoji = position.side === 'LONG' ? '🟢' : '🔴';
        const pnlEmoji = position.unrealizedPnl >= 0 ? '🟢' : '🔴';
        
        output += `${sideEmoji} **${position.symbol}** ${position.side} ${position.leverage}x\n`;
        output += `  Size: ${position.size.toFixed(4)} @ $${position.entryPrice.toFixed(4)}\n`;
        output += `  ${pnlEmoji} PnL: ${position.unrealizedPnl >= 0 ? '+' : ''}$${position.unrealizedPnl.toFixed(2)}`;
        output += ` (${position.pnlPercent >= 0 ? '+' : ''}${position.pnlPercent.toFixed(2)}%)\n`;
        output += `  Notional: $${position.notional.toFixed(2)} | ${position.marginType}\n\n`;
      });
    } else {
      output += '📭 **No open positions**\n\n';
    }

    // Asset breakdown (if multiple assets)
    const nonZeroAssets = summary.assets.filter(a => a.walletBalance > 0.01);
    if (nonZeroAssets.length > 1) {
      output += '**🏦 ASSET BREAKDOWN:**\n';
      nonZeroAssets.forEach(asset => {
        const pnlEmoji = asset.unrealizedPnl >= 0 ? '🟢' : '🔴';
        output += `• **${asset.asset}**: $${asset.walletBalance.toFixed(2)}`;
        if (Math.abs(asset.unrealizedPnl) > 0.01) {
          output += ` ${pnlEmoji}${asset.unrealizedPnl >= 0 ? '+' : ''}$${asset.unrealizedPnl.toFixed(2)}`;
        }
        output += `\n`;
      });
    }

    return output;
  }
}