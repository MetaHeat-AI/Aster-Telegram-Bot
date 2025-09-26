import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export interface PriceData {
  symbol: string;
  price: number;
  change24h?: number;
  volume24h?: number;
  lastUpdated: Date;
}

export class PriceService {
  private priceCache = new Map<string, PriceData>();
  private eventEmitter: BotEventEmitter;
  private cacheExpiry: number = 30 * 1000; // 30 seconds

  constructor(eventEmitter: BotEventEmitter) {
    this.eventEmitter = eventEmitter;
    
    // Clean up expired prices periodically
    setInterval(() => this.cleanupExpiredPrices(), 60 * 1000); // 1 minute
  }

  /**
   * Get current price for a symbol
   */
  async getCurrentPrice(symbol: string): Promise<number> {
    const startTime = Date.now();
    
    try {
      // Check cache first
      const cached = this.priceCache.get(symbol);
      if (cached && this.isCacheValid(cached)) {
        return cached.price;
      }

      // Fetch fresh price
      const price = await this.fetchPriceFromApi(symbol);
      
      // Update cache
      this.priceCache.set(symbol, {
        symbol,
        price,
        lastUpdated: new Date()
      });

      this.eventEmitter.emitEvent({
        type: EventTypes.API_CALL_SUCCESS,
        timestamp: new Date(),
        userId: 0, // System call
        telegramId: 0,
        endpoint: `/fapi/v1/ticker/24hr`,
        method: 'GET',
        success: true,
        duration: Date.now() - startTime
      });

      return price;
    } catch (error) {
      this.eventEmitter.emitEvent({
        type: EventTypes.API_CALL_FAILED,
        timestamp: new Date(),
        userId: 0,
        telegramId: 0,
        endpoint: `/fapi/v1/ticker/24hr`,
        method: 'GET',
        success: false,
        duration: Date.now() - startTime
      });

      // Return cached price if available, even if expired
      const cached = this.priceCache.get(symbol);
      if (cached) {
        console.warn(`[PriceService] Using stale price for ${symbol}:`, cached.price);
        return cached.price;
      }

      throw new Error(`Failed to get price for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate if a symbol exists and is tradeable
   */
  async validateSymbol(symbol: string): Promise<boolean> {
    try {
      await this.getCurrentPrice(symbol);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get multiple prices at once
   */
  async getMultiplePrices(symbols: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    
    // Fetch all prices concurrently
    const pricePromises = symbols.map(async (symbol) => {
      try {
        const price = await this.getCurrentPrice(symbol);
        prices.set(symbol, price);
      } catch (error) {
        console.warn(`[PriceService] Failed to get price for ${symbol}:`, error);
      }
    });

    await Promise.allSettled(pricePromises);
    return prices;
  }

  /**
   * Get cached price if available (no API call)
   */
  getCachedPrice(symbol: string): number | null {
    const cached = this.priceCache.get(symbol);
    return cached ? cached.price : null;
  }

  /**
   * Clear cache for a specific symbol
   */
  clearCache(symbol?: string): void {
    if (symbol) {
      this.priceCache.delete(symbol);
    } else {
      this.priceCache.clear();
    }
  }

  /**
   * Fetch price from external API
   */
  private async fetchPriceFromApi(symbol: string): Promise<number> {
    // Mock implementation - replace with actual API call
    // In production, this would call your price API
    const mockPrices: Record<string, number> = {
      'BTCUSDT': 45000 + Math.random() * 1000,
      'ETHUSDT': 2500 + Math.random() * 100,
      'SOLUSDT': 100 + Math.random() * 10,
      'BNBUSDT': 300 + Math.random() * 20,
      'ASTERUSDT': 1 + Math.random() * 0.1
    };

    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

    const price = mockPrices[symbol];
    if (!price) {
      throw new Error(`Price not found for symbol: ${symbol}`);
    }

    return price;
  }

  /**
   * Check if cached price is still valid
   */
  private isCacheValid(priceData: PriceData): boolean {
    const now = Date.now();
    const cacheTime = priceData.lastUpdated.getTime();
    return (now - cacheTime) < this.cacheExpiry;
  }

  /**
   * Clean up expired prices from cache
   */
  private cleanupExpiredPrices(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    
    for (const [symbol, priceData] of this.priceCache.entries()) {
      if (now - priceData.lastUpdated.getTime() > maxAge) {
        this.priceCache.delete(symbol);
      }
    }
  }
}