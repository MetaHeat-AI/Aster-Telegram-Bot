import { AsterApiClient } from '../aster';

export interface SpotBalance {
  asset: string;
  free: string;
  locked: string;
  total: number;
  usdValue?: number;
}

export interface SpotPortfolioSummary {
  totalUsdValue: number;
  totalAssets: number;
  usdtBalance: number;
  mainAssets: SpotBalance[];
  smallBalances: SpotBalance[];
}

export class SpotAccountService {
  private apiClient: AsterApiClient;

  constructor(apiClient: AsterApiClient) {
    this.apiClient = apiClient;
  }

  async getSpotBalances(): Promise<SpotBalance[]> {
    try {
      const accountInfo = await this.apiClient.getSpotAccount();
      const balancesWithTotal = accountInfo.balances
        .map(balance => {
          const free = parseFloat(balance.free);
          const locked = parseFloat(balance.locked);
          const total = free + locked;
          return { ...balance, total };
        })
        .filter(balance => balance.total > 0);

      // Fetch USD values in parallel
      const usdValuePromises = balancesWithTotal.map(async (balance) => {
        const usdValue = await this.getUsdValue(balance.asset, balance.total);
        return {
          asset: balance.asset,
          free: balance.free,
          locked: balance.locked,
          total: balance.total,
          usdValue
        };
      });

      const balances = await Promise.all(usdValuePromises);

      // Sort by USD value descending
      return balances.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    } catch (error) {
      console.error('[SpotAccountService] Failed to get spot balances:', error);
      return [];
    }
  }

  async getPortfolioSummary(): Promise<SpotPortfolioSummary> {
    const balances = await this.getSpotBalances();
    
    let totalUsdValue = 0;
    const usdtBalance = balances.find(b => b.asset === 'USDT')?.total || 0;
    
    // Calculate total USD value
    balances.forEach(balance => {
      totalUsdValue += balance.usdValue || 0;
    });

    // Separate main assets (>$10) from small balances
    const mainAssets = balances.filter(b => (b.usdValue || 0) >= 10);
    const smallBalances = balances.filter(b => (b.usdValue || 0) < 10 && b.asset !== 'USDT');

    return {
      totalUsdValue,
      totalAssets: balances.length,
      usdtBalance,
      mainAssets,
      smallBalances
    };
  }

  async getUsdtBalance(): Promise<number> {
    try {
      const balances = await this.getSpotBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      return usdtBalance?.total || 0;
    } catch (error) {
      console.error('[SpotAccountService] Failed to get USDT balance:', error);
      return 0;
    }
  }

  async getAssetBalance(asset: string): Promise<SpotBalance | null> {
    try {
      const balances = await this.getSpotBalances();
      return balances.find(b => b.asset === asset) || null;
    } catch (error) {
      console.error(`[SpotAccountService] Failed to get ${asset} balance:`, error);
      return null;
    }
  }

  private async getUsdValue(asset: string, amount: number): Promise<number> {
    if (asset === 'USDT' || asset === 'USDC') {
      return amount;
    }

    try {
      const symbol = `${asset}USDT`;
      const ticker = await this.apiClient.get24hrTicker(symbol);
      const price = parseFloat(ticker.lastPrice);
      return amount * price;
    } catch (error) {
      // If can't get price from futures API, try spot
      try {
        const allTickers = await this.apiClient.getAllSpotTickers();
        const ticker = allTickers.find(t => t.symbol === `${asset}USDT`);
        if (ticker) {
          const price = parseFloat(ticker.lastPrice);
          return amount * price;
        }
      } catch (spotError) {
        console.warn(`[SpotAccountService] Could not get USD value for ${asset}:`, error);
      }
      return 0;
    }
  }

  formatSpotPortfolio(summary: SpotPortfolioSummary): string {
    let output = [
      '',
      '🏪 **SPOT PORTFOLIO**',
      '─'.repeat(30),
      ''
    ].join('\n');

    // Calculate portfolio performance indicators
    const usdtPercentage = summary.totalUsdValue > 0 ? (summary.usdtBalance / summary.totalUsdValue * 100) : 0;
    const diversificationEmoji = summary.totalAssets > 10 ? '🌟' : summary.totalAssets > 5 ? '💫' : '🔸';

    // Portfolio overview with beautiful formatting
    output += [
      `💰 **Total Value:** $${summary.totalUsdValue.toFixed(2)}`,
      `💵 **USDT Balance:** $${summary.usdtBalance.toFixed(2)} (${usdtPercentage.toFixed(1)}%)`,
      `${diversificationEmoji} **Diversification:** ${summary.totalAssets} tokens`,
      ''
    ].join('\n');

    // Main holdings with enhanced visuals
    if (summary.mainAssets.length > 0) {
      output += '🏆 **Major Holdings:**\n';
      summary.mainAssets.forEach((balance, index) => {
        const percentage = summary.totalUsdValue > 0 ? (balance.usdValue! / summary.totalUsdValue * 100) : 0;
        const rank = index + 1;
        const progressBar = this.generateProgressBar(percentage, 12);
        
        // Asset performance indicators
        const concentrationEmoji = percentage > 50 ? '🎯' : percentage > 25 ? '🔥' : '💎';
        const medalEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '💫';
        
        output += [
          `${medalEmoji} **${rank}. ${balance.asset}** ${concentrationEmoji}`,
          `   📊 Holdings: ${balance.total.toFixed(4)} tokens`,
          `   💰 Value: $${balance.usdValue!.toFixed(2)} (${percentage.toFixed(1)}%)`,
          `   ${progressBar}`,
          parseFloat(balance.locked) > 0 ? `   🔒 Locked: ${balance.locked}` : '',
          ''
        ].filter(Boolean).join('\n');
      });
    }

    // Small balances section with enhanced formatting
    if (summary.smallBalances.length > 0) {
      const smallTotal = summary.smallBalances.reduce((sum, b) => sum + (b.usdValue || 0), 0);
      const smallPercentage = summary.totalUsdValue > 0 ? (smallTotal / summary.totalUsdValue * 100) : 0;
      
      output += [
        '🪙 **Small Holdings:**',
        `   📊 ${summary.smallBalances.length} assets • $${smallTotal.toFixed(2)} total (${smallPercentage.toFixed(1)}%)`,
        ''
      ].join('\n');
      
      // Show top 3 small balances in compact format with better spacing
      summary.smallBalances.slice(0, 3).forEach((balance, index) => {
        const bullet = index === 0 ? '▸' : index === 1 ? '▹' : '▫';
        output += `   ${bullet} **${balance.asset}**: $${balance.usdValue!.toFixed(2)}\n`;
      });
      
      if (summary.smallBalances.length > 3) {
        output += `   ▫ ... +${summary.smallBalances.length - 3} more assets\n`;
      }
      output += '\n';
    }

    // Add footer with helpful info
    output += [
      '─'.repeat(25),
      '💡 *Use /trade to start trading*',
      ''
    ].join('\n');

    return output;
  }

  private generateProgressBar(percentage: number, length: number): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `${bar} ${percentage.toFixed(1)}%`;
  }
}