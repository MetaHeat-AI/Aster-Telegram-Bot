import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export interface PriceData {
  symbol: string;
  price: number;
  change24h?: number;
  volume24h?: number;
  lastUpdated: Date;
}

export class PriceService {
  private eventEmitter: BotEventEmitter;

  constructor(eventEmitter: BotEventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /**
   * Get current price for a symbol
   */
  async getCurrentPrice(symbol: string): Promise<number> {
    const startTime = Date.now();
    
    try {
      // Fetch fresh price directly from API
      const price = await this.fetchPriceFromApi(symbol);

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
   * Fetch price from AsterDEX API
   */
  private async fetchPriceFromApi(symbol: string): Promise<number> {
    try {
      // Use the public AsterDEX API to get real market prices
      const AsterApiClient = await import('../aster');
      const publicClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
      
      // Get 24hr ticker data which includes current price
      const ticker = await publicClient.get24hrTicker(symbol);
      const price = parseFloat(ticker.lastPrice);
      
      if (!price || price <= 0) {
        throw new Error(`Invalid price data for symbol: ${symbol}`);
      }
      
      return price;
    } catch (error) {
      console.error(`[PriceService] Failed to fetch price for ${symbol}:`, error);
      throw new Error(`Failed to fetch price for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }


  /**
   * Get current prices for multiple symbols in parallel
   * Significant performance improvement for multiple price queries
   */
  async getCurrentPrices(symbols: string[]): Promise<Map<string, number>> {
    const startTime = Date.now();
    
    try {
      const pricePromises = symbols.map(async symbol => {
        try {
          const price = await this.getCurrentPrice(symbol);
          return [symbol, price] as [string, number];
        } catch (error) {
          console.error(`Failed to get price for ${symbol}:`, error);
          return [symbol, 0] as [string, number];
        }
      });

      const results = await Promise.all(pricePromises);
      const priceMap = new Map(results);
      
      this.eventEmitter.emitEvent({
        type: EventTypes.API_CALL_SUCCESS,
        timestamp: new Date(),
        userId: 0,
        telegramId: 0,
        endpoint: 'batch_price_fetch',
        method: 'GET',
        success: true,
        duration: Date.now() - startTime
      });

      return priceMap;
    } catch (error) {
      console.error('Batch price fetch failed:', error);
      
      // Return empty map with all zeros as fallback
      const fallbackMap = new Map<string, number>();
      symbols.forEach(symbol => fallbackMap.set(symbol, 0));
      return fallbackMap;
    }
  }
}