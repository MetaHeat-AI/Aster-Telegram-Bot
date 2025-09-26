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
      const balances: SpotBalance[] = [];

      for (const balance of accountInfo.balances) {
        const free = parseFloat(balance.free);
        const locked = parseFloat(balance.locked);
        const total = free + locked;

        if (total > 0) {
          balances.push({
            asset: balance.asset,
            free: balance.free,
            locked: balance.locked,
            total,
            usdValue: await this.getUsdValue(balance.asset, total)
          });
        }
      }

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
    let output = '💰 **SPOT PORTFOLIO**\n';
    output += '═'.repeat(40) + '\n\n';

    // Portfolio overview
    output += `📊 **Total Value:** $${summary.totalUsdValue.toFixed(2)}\n`;
    output += `💵 **USDT Balance:** $${summary.usdtBalance.toFixed(2)}\n`;
    output += `🏦 **Total Assets:** ${summary.totalAssets}\n\n`;

    // Main holdings
    if (summary.mainAssets.length > 0) {
      output += '**🏆 Main Holdings (>$10):**\n';
      summary.mainAssets.forEach(balance => {
        const percentage = summary.totalUsdValue > 0 ? (balance.usdValue! / summary.totalUsdValue * 100) : 0;
        output += `• **${balance.asset}**: ${balance.total.toFixed(6)} `;
        output += `($${balance.usdValue!.toFixed(2)} • ${percentage.toFixed(1)}%)\n`;
        if (parseFloat(balance.locked) > 0) {
          output += `  └ Locked: ${balance.locked}\n`;
        }
      });
      output += '\n';
    }

    // Small balances
    if (summary.smallBalances.length > 0) {
      output += '**🪙 Small Holdings (<$10):**\n';
      const smallTotal = summary.smallBalances.reduce((sum, b) => sum + (b.usdValue || 0), 0);
      output += `${summary.smallBalances.length} assets worth $${smallTotal.toFixed(2)} total\n`;
      
      // Show up to 3 small balances
      summary.smallBalances.slice(0, 3).forEach(balance => {
        output += `• ${balance.asset}: ${balance.total.toFixed(6)} ($${balance.usdValue!.toFixed(2)})\n`;
      });
      
      if (summary.smallBalances.length > 3) {
        output += `• ... and ${summary.smallBalances.length - 3} more\n`;
      }
    }

    return output;
  }
}