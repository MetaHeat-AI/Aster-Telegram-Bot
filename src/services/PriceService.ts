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
   * Fetch price from AsterDEX API with proper connection handling
   * Uses spot API (sapi) for spot symbols and futures API (fapi) for perps
   */
  private async fetchPriceFromApi(symbol: string): Promise<number> {
    try {
      const AsterApiClient = await import('../aster');
      
      // Try spot API first (sapi.asterdex.com) since most trading pairs are available on spot
      try {
        console.log(`[PriceService] Trying spot API for ${symbol}`);
        const spotClient = new AsterApiClient.AsterApiClient('https://sapi.asterdex.com', '', '');
        const spotTickers = await spotClient.getAllSpotTickers();
        const spotTicker = spotTickers.find((t: any) => t.symbol === symbol);
        
        if (spotTicker && spotTicker.lastPrice) {
          const price = parseFloat(spotTicker.lastPrice);
          if (price > 0) {
            console.log(`[PriceService] Successfully fetched spot price for ${symbol}: $${price}`);
            return price;
          }
        }
      } catch (spotError) {
        console.log(`[PriceService] Spot API failed for ${symbol}, trying futures API`);
      }
      
      // If spot fails, try futures API (fapi.asterdex.com)
      console.log(`[PriceService] Trying futures API for ${symbol}`);
      const futuresClient = new AsterApiClient.AsterApiClient('https://fapi.asterdex.com', '', '');
      const ticker = await futuresClient.get24hrTicker(symbol);
      const price = parseFloat(ticker.lastPrice);
      
      if (!price || price <= 0) {
        throw new Error(`Invalid price data received for ${symbol}: ${ticker.lastPrice}`);
      }
      
      console.log(`[PriceService] Successfully fetched futures price for ${symbol}: $${price}`);
      return price;
    } catch (error) {
      console.error(`[PriceService] Both spot and futures API calls failed for ${symbol}:`, error);
      
      // Re-throw the error with clear messaging for the UI
      if (error instanceof Error) {
        if (error.message.includes('Network error') || error.message.includes('timeout')) {
          throw new Error(`Connection to AsterDEX API failed. Please check your internet connection and try again.`);
        }
        if (error.message.includes('Invalid price data')) {
          throw new Error(`Invalid price data received from AsterDEX API for ${symbol}.`);
        }
        throw new Error(`AsterDEX API error for ${symbol}: ${error.message}`);
      }
      
      throw new Error(`Failed to fetch price for ${symbol}: Unknown error`);
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