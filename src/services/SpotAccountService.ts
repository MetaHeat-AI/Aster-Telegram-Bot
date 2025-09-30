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
      // For spot account service, use spot API directly
      const allTickers = await this.apiClient.getAllSpotTickers();
      const ticker = allTickers.find(t => t.symbol === symbol);
      if (ticker) {
        const price = parseFloat(ticker.lastPrice);
        return amount * price;
      } else {
        console.warn(`[SpotAccountService] No spot ticker found for ${symbol}`);
        return 0;
      }
    } catch (error) {
      console.warn(`[SpotAccountService] Could not get USD value for ${asset}:`, error);
      return 0;
    }
  }

  formatSpotPortfolio(summary: SpotPortfolioSummary): string {
    let output = '\n🏪 **SPOT** • $' + summary.totalUsdValue.toFixed(2) + '\n';

    // Only show main assets if they exist and are meaningful
    if (summary.mainAssets.length > 0 && summary.totalUsdValue > 1) {
      summary.mainAssets.slice(0, 3).forEach((balance, index) => {
        const percentage = summary.totalUsdValue > 0 ? (balance.usdValue! / summary.totalUsdValue * 100) : 0;
        const emoji = index === 0 ? '▸' : '▫';
        output += `${emoji} ${balance.asset}: $${balance.usdValue!.toFixed(2)} (${percentage.toFixed(0)}%)\n`;
      });
    } else {
      // Compact display for small balances
      output += `💵 USDT: $${summary.usdtBalance.toFixed(2)}\n`;
    }

    // Show small balances count if any
    if (summary.smallBalances.length > 0) {
      const smallTotal = summary.smallBalances.reduce((sum, b) => sum + (b.usdValue || 0), 0);
      output += `▫ +${summary.smallBalances.length} small • $${smallTotal.toFixed(2)}\n`;
    }

    return output;
  }

  private generateProgressBar(percentage: number, length: number): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `${bar} ${percentage.toFixed(1)}%`;
  }
}