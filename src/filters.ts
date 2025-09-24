import { 
  SymbolInfo, 
  PriceFilter, 
  LotSizeFilter, 
  MinNotionalFilter, 
  PercentPriceFilter,
  MarketLotSizeFilter,
  MaxNumOrdersFilter,
  OrderBookDepth 
} from './types';

export interface FilterValidationResult {
  isValid: boolean;
  errors: string[];
  adjustedPrice?: string;
  adjustedQuantity?: string;
}

export interface PriceImpactResult {
  estimatedPrice: string;
  priceImpact: number;
  slippage: number;
  isAcceptable: boolean;
  worstPrice: string;
}

export class FiltersManager {
  private symbolFilters = new Map<string, SymbolFilters>();

  constructor() {}

  // Load and cache filters for a symbol
  loadSymbolFilters(symbolInfo: SymbolInfo): void {
    const filters = new SymbolFilters(symbolInfo);
    this.symbolFilters.set(symbolInfo.symbol, filters);
  }

  // Get filters for a symbol
  getSymbolFilters(symbol: string): SymbolFilters | null {
    return this.symbolFilters.get(symbol) || null;
  }

  // Validate and adjust order parameters
  validateOrder(
    symbol: string,
    price: string,
    quantity: string,
    orderType: 'MARKET' | 'LIMIT',
    isReduceOnly = false
  ): FilterValidationResult {
    const filters = this.getSymbolFilters(symbol);
    if (!filters) {
      return {
        isValid: false,
        errors: [`No filters found for symbol ${symbol}`],
      };
    }

    return filters.validateOrder(price, quantity, orderType, isReduceOnly);
  }

  // Calculate price impact and slippage
  async calculatePriceImpact(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    orderBook: OrderBookDepth,
    maxSlippageBps: number
  ): Promise<PriceImpactResult> {
    const filters = this.getSymbolFilters(symbol);
    if (!filters) {
      throw new Error(`No filters found for symbol ${symbol}`);
    }

    const orders = side === 'BUY' ? orderBook.asks : orderBook.bids;
    if (orders.length === 0) {
      throw new Error('No orders available in order book');
    }

    const bestPrice = parseFloat(orders[0][0]);
    let remainingQty = parseFloat(quantity);
    let totalCost = 0;
    let worstPrice = bestPrice;

    // Calculate average execution price
    for (const [priceStr, qtyStr] of orders) {
      if (remainingQty <= 0) break;

      const price = parseFloat(priceStr);
      const availableQty = parseFloat(qtyStr);
      const fillQty = Math.min(remainingQty, availableQty);

      totalCost += fillQty * price;
      remainingQty -= fillQty;
      worstPrice = price;
    }

    if (remainingQty > 0) {
      throw new Error('Insufficient liquidity in order book');
    }

    const averagePrice = totalCost / parseFloat(quantity);
    const priceImpact = Math.abs(averagePrice - bestPrice) / bestPrice;
    const slippage = priceImpact * 10000; // Convert to basis points

    return {
      estimatedPrice: averagePrice.toFixed(filters.getPricePrecision()),
      priceImpact,
      slippage,
      isAcceptable: slippage <= maxSlippageBps,
      worstPrice: worstPrice.toFixed(filters.getPricePrecision()),
    };
  }

  // Get minimum order size in quote currency
  getMinNotional(symbol: string): number {
    const filters = this.getSymbolFilters(symbol);
    return filters?.getMinNotional() || 0;
  }

  // Get tick size for price rounding
  getTickSize(symbol: string): number {
    const filters = this.getSymbolFilters(symbol);
    return filters?.getTickSize() || 0;
  }

  // Get step size for quantity rounding
  getStepSize(symbol: string): number {
    const filters = this.getSymbolFilters(symbol);
    return filters?.getStepSize() || 0;
  }
}

export class SymbolFilters {
  private symbol: string;
  private filters: Map<string, any> = new Map();
  private priceFilter?: PriceFilter;
  private lotSizeFilter?: LotSizeFilter;
  private marketLotSizeFilter?: MarketLotSizeFilter;
  private minNotionalFilter?: MinNotionalFilter;
  private percentPriceFilter?: PercentPriceFilter;
  private maxNumOrdersFilter?: MaxNumOrdersFilter;

  constructor(symbolInfo: SymbolInfo) {
    this.symbol = symbolInfo.symbol;
    
    // Parse and store filters
    symbolInfo.filters.forEach(filter => {
      this.filters.set(filter.filterType, filter);
      
      switch (filter.filterType) {
        case 'PRICE_FILTER':
          this.priceFilter = filter as PriceFilter;
          break;
        case 'LOT_SIZE':
          this.lotSizeFilter = filter as LotSizeFilter;
          break;
        case 'MARKET_LOT_SIZE':
          this.marketLotSizeFilter = filter as MarketLotSizeFilter;
          break;
        case 'MIN_NOTIONAL':
          this.minNotionalFilter = filter as MinNotionalFilter;
          break;
        case 'PERCENT_PRICE':
          this.percentPriceFilter = filter as PercentPriceFilter;
          break;
        case 'MAX_NUM_ORDERS':
          this.maxNumOrdersFilter = filter as MaxNumOrdersFilter;
          break;
      }
    });
  }

  validateOrder(
    price: string,
    quantity: string,
    orderType: 'MARKET' | 'LIMIT',
    isReduceOnly = false
  ): FilterValidationResult {
    const errors: string[] = [];
    let adjustedPrice = price;
    let adjustedQuantity = quantity;

    // Price filter validation (for LIMIT orders)
    if (orderType === 'LIMIT' && this.priceFilter) {
      const priceValidation = this.validatePrice(price);
      if (!priceValidation.isValid) {
        if (priceValidation.adjustedValue) {
          adjustedPrice = priceValidation.adjustedValue;
        } else {
          errors.push(...priceValidation.errors);
        }
      }
    }

    // Quantity filter validation
    const qtyFilter = orderType === 'MARKET' ? this.marketLotSizeFilter : this.lotSizeFilter;
    if (qtyFilter) {
      const qtyValidation = this.validateQuantity(quantity, qtyFilter);
      if (!qtyValidation.isValid) {
        if (qtyValidation.adjustedValue) {
          adjustedQuantity = qtyValidation.adjustedValue;
        } else {
          errors.push(...qtyValidation.errors);
        }
      }
    }

    // Min notional validation
    if (this.minNotionalFilter && !isReduceOnly) {
      const notionalValidation = this.validateNotional(adjustedPrice, adjustedQuantity, orderType);
      if (!notionalValidation.isValid) {
        errors.push(...notionalValidation.errors);
      }
    }

    // Percent price validation (for LIMIT orders)
    if (orderType === 'LIMIT' && this.percentPriceFilter) {
      const percentValidation = this.validatePercentPrice(price);
      if (!percentValidation.isValid) {
        errors.push(...percentValidation.errors);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      adjustedPrice: adjustedPrice !== price ? adjustedPrice : undefined,
      adjustedQuantity: adjustedQuantity !== quantity ? adjustedQuantity : undefined,
    };
  }

  private validatePrice(price: string): { isValid: boolean; errors: string[]; adjustedValue?: string } {
    if (!this.priceFilter) return { isValid: true, errors: [] };

    const priceNum = parseFloat(price);
    const minPrice = parseFloat(this.priceFilter.minPrice);
    const maxPrice = parseFloat(this.priceFilter.maxPrice);
    const tickSize = parseFloat(this.priceFilter.tickSize);

    const errors: string[] = [];

    // Check min/max bounds
    if (priceNum < minPrice) {
      errors.push(`Price ${price} is below minimum ${this.priceFilter.minPrice}`);
      return { isValid: false, errors };
    }

    if (priceNum > maxPrice) {
      errors.push(`Price ${price} is above maximum ${this.priceFilter.maxPrice}`);
      return { isValid: false, errors };
    }

    // Check tick size compliance
    const remainder = (priceNum - minPrice) % tickSize;
    if (Math.abs(remainder) > Number.EPSILON) {
      // Auto-adjust to nearest valid tick
      const adjustedPrice = minPrice + Math.round((priceNum - minPrice) / tickSize) * tickSize;
      const precision = this.getPricePrecision();
      
      return {
        isValid: false,
        errors: [`Price ${price} adjusted to ${adjustedPrice.toFixed(precision)} to comply with tick size ${tickSize}`],
        adjustedValue: adjustedPrice.toFixed(precision),
      };
    }

    return { isValid: true, errors: [] };
  }

  private validateQuantity(
    quantity: string,
    filter: LotSizeFilter | MarketLotSizeFilter
  ): { isValid: boolean; errors: string[]; adjustedValue?: string } {
    const qtyNum = parseFloat(quantity);
    const minQty = parseFloat(filter.minQty);
    const maxQty = parseFloat(filter.maxQty);
    const stepSize = parseFloat(filter.stepSize);

    const errors: string[] = [];

    // Check min/max bounds
    if (qtyNum < minQty) {
      errors.push(`Quantity ${quantity} is below minimum ${filter.minQty}`);
      return { isValid: false, errors };
    }

    if (qtyNum > maxQty) {
      errors.push(`Quantity ${quantity} is above maximum ${filter.maxQty}`);
      return { isValid: false, errors };
    }

    // Check step size compliance
    const remainder = qtyNum % stepSize;
    if (Math.abs(remainder) > Number.EPSILON) {
      // Auto-adjust to nearest valid step
      const adjustedQty = Math.round(qtyNum / stepSize) * stepSize;
      const precision = this.getQuantityPrecision();
      
      return {
        isValid: false,
        errors: [`Quantity ${quantity} adjusted to ${adjustedQty.toFixed(precision)} to comply with step size ${stepSize}`],
        adjustedValue: adjustedQty.toFixed(precision),
      };
    }

    return { isValid: true, errors: [] };
  }

  private validateNotional(
    price: string,
    quantity: string,
    orderType: 'MARKET' | 'LIMIT'
  ): { isValid: boolean; errors: string[] } {
    if (!this.minNotionalFilter) return { isValid: true, errors: [] };

    const minNotional = parseFloat(this.minNotionalFilter.notional);
    let notional: number;

    if (orderType === 'MARKET') {
      // For market orders, we need to estimate the notional
      // This is a simplified calculation - in practice you'd use order book
      notional = parseFloat(price) * parseFloat(quantity);
    } else {
      notional = parseFloat(price) * parseFloat(quantity);
    }

    if (notional < minNotional) {
      return {
        isValid: false,
        errors: [`Order notional ${notional.toFixed(2)} is below minimum ${minNotional}`],
      };
    }

    return { isValid: true, errors: [] };
  }

  private validatePercentPrice(price: string): { isValid: boolean; errors: string[] } {
    if (!this.percentPriceFilter) return { isValid: true, errors: [] };

    // This would require mark price from the API
    // For now, just return valid - implement when mark price is available
    return { isValid: true, errors: [] };
  }

  // Helper methods
  getTickSize(): number {
    return this.priceFilter ? parseFloat(this.priceFilter.tickSize) : 0;
  }

  getStepSize(): number {
    return this.lotSizeFilter ? parseFloat(this.lotSizeFilter.stepSize) : 0;
  }

  getMinNotional(): number {
    return this.minNotionalFilter ? parseFloat(this.minNotionalFilter.notional) : 0;
  }

  getMinPrice(): number {
    return this.priceFilter ? parseFloat(this.priceFilter.minPrice) : 0;
  }

  getMaxPrice(): number {
    return this.priceFilter ? parseFloat(this.priceFilter.maxPrice) : 0;
  }

  getMinQty(): number {
    return this.lotSizeFilter ? parseFloat(this.lotSizeFilter.minQty) : 0;
  }

  getMaxQty(): number {
    return this.lotSizeFilter ? parseFloat(this.lotSizeFilter.maxQty) : 0;
  }

  getPricePrecision(): number {
    if (!this.priceFilter) return 8;
    
    const tickSize = this.priceFilter.tickSize;
    const decimals = tickSize.split('.')[1];
    return decimals ? decimals.length : 0;
  }

  getQuantityPrecision(): number {
    if (!this.lotSizeFilter) return 8;
    
    const stepSize = this.lotSizeFilter.stepSize;
    const decimals = stepSize.split('.')[1];
    return decimals ? decimals.length : 0;
  }

  // Round price to tick size
  roundPrice(price: number): string {
    if (!this.priceFilter) return price.toString();
    
    const tickSize = parseFloat(this.priceFilter.tickSize);
    const minPrice = parseFloat(this.priceFilter.minPrice);
    const precision = this.getPricePrecision();
    
    const rounded = minPrice + Math.round((price - minPrice) / tickSize) * tickSize;
    return rounded.toFixed(precision);
  }

  // Round quantity to step size
  roundQuantity(quantity: number): string {
    if (!this.lotSizeFilter) return quantity.toString();
    
    const stepSize = parseFloat(this.lotSizeFilter.stepSize);
    const precision = this.getQuantityPrecision();
    
    const rounded = Math.round(quantity / stepSize) * stepSize;
    return rounded.toFixed(precision);
  }
}

// Utility functions for price calculations
export class PriceUtils {
  // Convert quote amount to base quantity
  static quoteToBase(quoteAmount: number, price: number): number {
    return quoteAmount / price;
  }

  // Convert base quantity to quote amount
  static baseToQuote(baseQuantity: number, price: number): number {
    return baseQuantity * price;
  }

  // Calculate percentage change
  static percentageChange(oldPrice: number, newPrice: number): number {
    return ((newPrice - oldPrice) / oldPrice) * 100;
  }

  // Calculate price with slippage
  static priceWithSlippage(price: number, slippageBps: number, side: 'BUY' | 'SELL'): number {
    const slippageFactor = slippageBps / 10000;
    
    if (side === 'BUY') {
      return price * (1 + slippageFactor); // Worse price for buying
    } else {
      return price * (1 - slippageFactor); // Worse price for selling
    }
  }

  // Calculate stop loss price
  static calculateStopLoss(entryPrice: number, stopLossPercent: number, side: 'BUY' | 'SELL'): number {
    const factor = stopLossPercent / 100;
    
    if (side === 'BUY') {
      return entryPrice * (1 - factor); // SL below entry for long
    } else {
      return entryPrice * (1 + factor); // SL above entry for short
    }
  }

  // Calculate take profit price
  static calculateTakeProfit(entryPrice: number, takeProfitPercent: number, side: 'BUY' | 'SELL'): number {
    const factor = takeProfitPercent / 100;
    
    if (side === 'BUY') {
      return entryPrice * (1 + factor); // TP above entry for long
    } else {
      return entryPrice * (1 - factor); // TP below entry for short
    }
  }

  // Format price for display
  static formatPrice(price: number, precision: number = 4): string {
    return price.toFixed(precision);
  }

  // Format quantity for display
  static formatQuantity(quantity: number, precision: number = 4): string {
    return quantity.toFixed(precision);
  }

  // Parse price with safety checks
  static parsePrice(priceStr: string): number {
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) {
      throw new Error(`Invalid price: ${priceStr}`);
    }
    return price;
  }

  // Parse quantity with safety checks
  static parseQuantity(quantityStr: string): number {
    const quantity = parseFloat(quantityStr);
    if (isNaN(quantity) || quantity <= 0) {
      throw new Error(`Invalid quantity: ${quantityStr}`);
    }
    return quantity;
  }
}