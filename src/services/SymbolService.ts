import { AsterApiClient } from '../aster';

export interface SymbolData {
  symbol: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  priceChangePercent: string;
  isSpotAvailable: boolean;
  isFuturesAvailable: boolean;
}

export class SymbolService {
  private apiClient: AsterApiClient;
  private symbolCache: Map<string, SymbolData> = new Map();
  private lastCacheUpdate: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(apiClient: AsterApiClient) {
    this.apiClient = apiClient;
  }

  async getAvailableSymbols(): Promise<SymbolData[]> {
    // Check cache first
    if (this.isCacheValid()) {
      return Array.from(this.symbolCache.values());
    }

    await this.refreshSymbolCache();
    return Array.from(this.symbolCache.values());
  }

  async getTopSymbolsByVolume(count: number = 10, type: 'spot' | 'futures' | 'both' = 'both'): Promise<SymbolData[]> {
    const symbols = await this.getAvailableSymbols();
    
    // Filter by type
    let filteredSymbols = symbols;
    if (type === 'spot') {
      filteredSymbols = symbols.filter(s => s.isSpotAvailable);
    } else if (type === 'futures') {
      filteredSymbols = symbols.filter(s => s.isFuturesAvailable);
    }

    // Filter USDT pairs only
    const usdtPairs = filteredSymbols.filter(s => s.symbol.endsWith('USDT'));
    
    // Sort by quote volume (trading volume in USDT)
    const sortedByVolume = usdtPairs.sort((a, b) => {
      const volumeA = parseFloat(a.quoteVolume || '0');
      const volumeB = parseFloat(b.quoteVolume || '0');
      return volumeB - volumeA;
    });

    return sortedByVolume.slice(0, count);
  }

  async getSpotSymbols(limit?: number): Promise<SymbolData[]> {
    const symbols = await this.getAvailableSymbols();
    const spotSymbols = symbols.filter(s => s.isSpotAvailable && s.symbol.endsWith('USDT'));
    
    if (limit) {
      return spotSymbols.slice(0, limit);
    }
    return spotSymbols;
  }

  async getFuturesSymbols(limit?: number): Promise<SymbolData[]> {
    const symbols = await this.getAvailableSymbols();
    const futuresSymbols = symbols.filter(s => s.isFuturesAvailable && s.symbol.endsWith('USDT'));
    
    if (limit) {
      return futuresSymbols.slice(0, limit);
    }
    return futuresSymbols;
  }

  async isSymbolAvailable(symbol: string, type: 'spot' | 'futures'): Promise<boolean> {
    const symbols = await this.getAvailableSymbols();
    const symbolData = symbols.find(s => s.symbol === symbol);
    
    if (!symbolData) return false;
    
    return type === 'spot' ? symbolData.isSpotAvailable : symbolData.isFuturesAvailable;
  }

  private async refreshSymbolCache(): Promise<void> {
    try {
      console.log('[SymbolService] Refreshing symbol cache...');
      
      // Get data from both spot and futures APIs
      const [spotTickers, futuresTickers, spotExchangeInfo, futuresExchangeInfo] = await Promise.all([
        this.apiClient.getAllSpotTickers(),
        this.apiClient.getAllFuturesTickers(),
        this.safeGetSpotExchangeInfo(),
        this.safeGetFuturesExchangeInfo()
      ]);

      // Get available symbols from exchange info
      const spotSymbols = new Set(
        (spotExchangeInfo?.symbols || [])
          .filter((s: any) => s.status === 'TRADING')
          .map((s: any) => s.symbol)
      );

      const futuresSymbols = new Set(
        (futuresExchangeInfo?.symbols || [])
          .filter((s: any) => s.status === 'TRADING')
          .map((s: any) => s.symbol)
      );

      // Create combined symbol data
      const allSymbols = new Set<string>();
      spotTickers.forEach(t => allSymbols.add(t.symbol));
      futuresTickers.forEach(t => allSymbols.add(t.symbol));

      this.symbolCache.clear();

      for (const symbol of allSymbols) {
        const spotData = spotTickers.find(t => t.symbol === symbol);
        const futuresData = futuresTickers.find(t => t.symbol === symbol);
        
        // Use the data source with higher volume, or futures as fallback
        const primaryData = futuresData || spotData;
        if (!primaryData) continue;

        const symbolData: SymbolData = {
          symbol,
          lastPrice: primaryData.lastPrice,
          volume: primaryData.volume,
          quoteVolume: primaryData.quoteVolume || '0',
          priceChangePercent: primaryData.priceChangePercent,
          isSpotAvailable: spotSymbols.has(symbol),
          isFuturesAvailable: futuresSymbols.has(symbol)
        };

        this.symbolCache.set(symbol, symbolData);
      }

      this.lastCacheUpdate = Date.now();
      console.log(`[SymbolService] Cache refreshed with ${this.symbolCache.size} symbols`);
      
    } catch (error) {
      console.error('[SymbolService] Failed to refresh symbol cache:', error);
      // Keep existing cache if refresh fails
    }
  }

  private async safeGetSpotExchangeInfo(): Promise<any> {
    try {
      return await this.apiClient.getSpotExchangeInfo();
    } catch (error) {
      console.warn('[SymbolService] Failed to get spot exchange info:', error);
      return { symbols: [] };
    }
  }

  private async safeGetFuturesExchangeInfo(): Promise<any> {
    try {
      return await this.apiClient.getExchangeInfo();
    } catch (error) {
      console.warn('[SymbolService] Failed to get futures exchange info:', error);
      return { symbols: [] };
    }
  }

  private isCacheValid(): boolean {
    return (
      this.symbolCache.size > 0 &&
      Date.now() - this.lastCacheUpdate < this.CACHE_TTL
    );
  }

  // Helper method to get popular symbols with emojis
  getSymbolEmoji(symbol: string): string {
    const symbolMap: Record<string, string> = {
      'BTCUSDT': '₿',
      'ETHUSDT': '⟠',
      'SOLUSDT': '◎',
      'ADAUSDT': '🔷',
      'BNBUSDT': '🟡',
      'XRPUSDT': '💧',
      'DOTUSDT': '🔴',
      'AVAXUSDT': '🔺',
      'MATICUSDT': '🟣',
      'LINKUSDT': '🔗',
      'ATOMUSDT': '⚛️',
      'FTMUSDT': '👻',
      'NEARUSDT': '🌐',
      'ICPUSDT': '∞',
      'FILUSDT': '📁',
      'LTCUSDT': '🥈',
      'ASTERUSDT': '🪙'
    };
    
    return symbolMap[symbol] || '💰';
  }

  // Helper method to get clean symbol name (remove USDT)
  getCleanSymbolName(symbol: string): string {
    return symbol.replace('USDT', '');
  }
}