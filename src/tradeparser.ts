import { TradeCommand, TradePreview, TradeCommandSchema, UserSettings, OrderBookDepth } from './types';
import { FiltersManager } from './filters';
import { PriceProtectionManager } from './priceguard';
import { PriceUtils } from './filters';

export interface ParseResult {
  success: boolean;
  command?: TradeCommand;
  errors: string[];
  suggestions: string[];
}

export interface PreviewResult {
  success: boolean;
  preview?: TradePreview;
  errors: string[];
  warnings: string[];
}

export class TradeParser {
  private static readonly SYMBOL_PATTERNS = [
    /([A-Z]{2,10}USDT?)/i,
    /([A-Z]{2,10}USD)/i,
    /([A-Z]{2,10}BUSD)/i,
    /([A-Z]{2,10})/i, // Fallback for any uppercase sequence
  ];

  private static readonly SIZE_PATTERNS = [
    /(\d+(?:\.\d+)?)u/i, // Quote notation: 100u
    /(\d+(?:\.\d+)?)(?:\s+)?(?:usdt?|usd|busd)/i, // Quote with currency
    /(\d+(?:\.\d+)?)/i, // Plain number (base)
  ];

  private static readonly LEVERAGE_PATTERNS = [
    /(?:x|leverage\s+)(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)x/i,
  ];

  private static readonly STOP_LOSS_PATTERNS = [
    /sl(\d+(?:\.\d+)?)%?/i,
    /stop\s*loss\s*(\d+(?:\.\d+)?)%?/i,
    /sl=(\d+(?:\.\d+)?)%?/i,
  ];

  private static readonly TAKE_PROFIT_PATTERNS = [
    /tp(\d+(?:\.\d+)?)%?/i,
    /take\s*profit\s*(\d+(?:\.\d+)?)%?/i,
    /tp=(\d+(?:\.\d+)?)%?/i,
  ];

  private static readonly TRAILING_PATTERNS = [
    /trail(?:ing)?(\d+(?:\.\d+)?)%?/i,
    /trail=(\d+(?:\.\d+)?)%?/i,
  ];

  private static readonly ORDER_TYPE_PATTERNS = [
    /\b(market|mkt|m)\b/i,
    /\b(limit|lmt|l)\b/i,
  ];

  private static readonly REDUCE_PATTERNS = [
    /\b(reduce|red)\b/i,
    /\b(reduce[_\s]?only)\b/i,
  ];

  static parseTradeCommand(input: string): ParseResult {
    const errors: string[] = [];
    const suggestions: string[] = [];

    try {
      const normalizedInput = input.trim().toLowerCase();
      
      // Determine action (buy/sell)
      let action: 'BUY' | 'SELL';
      if (normalizedInput.startsWith('/buy') || normalizedInput.includes(' buy ')) {
        action = 'BUY';
      } else if (normalizedInput.startsWith('/sell') || normalizedInput.includes(' sell ')) {
        action = 'SELL';
      } else {
        return {
          success: false,
          errors: ['Command must start with /buy or /sell'],
          suggestions: ['Try: /buy BTCUSDT 100u x5 sl1% tp3%'],
        };
      }

      // Extract symbol
      const symbol = this.extractSymbol(input);
      if (!symbol) {
        return {
          success: false,
          errors: ['Could not identify trading symbol'],
          suggestions: ['Include a valid symbol like BTCUSDT, ETHUSDT, etc.'],
        };
      }

      // Extract size and determine if it's base or quote
      const sizeInfo = this.extractSize(input);
      if (!sizeInfo) {
        return {
          success: false,
          errors: ['Could not identify order size'],
          suggestions: ['Specify size like: 100u (quote) or 0.25 (base)'],
        };
      }

      // Extract optional parameters
      const leverage = this.extractLeverage(input);
      const stopLoss = this.extractStopLoss(input);
      const takeProfit = this.extractTakeProfit(input);
      const trailing = this.extractTrailing(input);
      const orderType = this.extractOrderType(input);
      const reduceOnly = this.extractReduceOnly(input);

      const command: TradeCommand = {
        action,
        symbol: symbol.toUpperCase(),
        size: sizeInfo.size,
        sizeType: sizeInfo.type,
        leverage,
        orderType: orderType || 'MARKET',
        stopLoss,
        takeProfit,
        trailing,
        reduceOnly,
      };

      // Validate the command
      try {
        TradeCommandSchema.parse(command);
      } catch (validationError) {
        return {
          success: false,
          errors: ['Invalid command format'],
          suggestions: ['Check your command syntax'],
        };
      }

      // Add helpful suggestions
      if (!leverage && !reduceOnly) {
        suggestions.push('Consider adding leverage (e.g., x5)');
      }
      
      if (!stopLoss && !takeProfit && !reduceOnly) {
        suggestions.push('Consider adding risk management (sl1% tp3%)');
      }

      return {
        success: true,
        command,
        errors: [],
        suggestions,
      };

    } catch (error) {
      return {
        success: false,
        errors: [`Parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        suggestions: ['Try: /buy BTCUSDT 100u x5 sl1% tp3%'],
      };
    }
  }

  private static extractSymbol(input: string): string | null {
    // Keywords to exclude from symbol matching
    const excludeKeywords = /^(buy|sell|market|limit|stop|close|long|short)$/i;
    
    for (const pattern of this.SYMBOL_PATTERNS) {
      // Find all matches, not just the first one
      const matches = Array.from(input.matchAll(new RegExp(pattern, 'gi')));
      for (const match of matches) {
        const symbol = match[1];
        // Skip if it's an action keyword
        if (excludeKeywords.test(symbol)) {
          continue;
        }
        // Ensure it ends with a quote asset if not already
        if (!/USDT?$|USD$|BUSD$/i.test(symbol)) {
          return `${symbol}USDT`;
        }
        return symbol;
      }
    }
    return null;
  }

  private static extractSize(input: string): { size: string; type: 'BASE' | 'QUOTE' } | null {
    console.log('[DEBUG] extractSize input:', input);
    
    // Check for quote notation first (100u, 100usdt)
    const quoteMatch = input.match(/(\d+(?:\.\d+)?)(?:u|usdt?|usd|busd)\b/i);
    console.log('[DEBUG] quoteMatch:', quoteMatch);
    if (quoteMatch) {
      return {
        size: quoteMatch[1],
        type: 'QUOTE',
      };
    }

    // Check for base notation (plain number)
    const baseMatch = input.match(/\b(\d+(?:\.\d+)?)\b(?!\s*[xu%])/);
    console.log('[DEBUG] baseMatch:', baseMatch);
    if (baseMatch) {
      // Make sure it's not part of leverage or percentage
      const beforeMatch = input.substring(0, baseMatch.index || 0);
      const afterMatch = input.substring((baseMatch.index || 0) + baseMatch[0].length);
      console.log('[DEBUG] beforeMatch:', beforeMatch, 'afterMatch:', afterMatch);
      
      if (!afterMatch.match(/^\s*[xu%]/) && !beforeMatch.match(/[sl|tp|trail]\s*$/i)) {
        console.log('[DEBUG] Found valid base size:', baseMatch[1]);
        return {
          size: baseMatch[1],
          type: 'BASE',
        };
      } else {
        console.log('[DEBUG] Base match rejected due to context');
      }
    } else {
      console.log('[DEBUG] No base match found');
    }

    console.log('[DEBUG] extractSize returning null');
    return null;
  }

  private static extractLeverage(input: string): number | undefined {
    for (const pattern of this.LEVERAGE_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        const leverage = parseFloat(match[1]);
        return leverage > 0 && leverage <= 125 ? leverage : undefined;
      }
    }
    return undefined;
  }

  private static extractStopLoss(input: string): string | undefined {
    for (const pattern of this.STOP_LOSS_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  private static extractTakeProfit(input: string): string | undefined {
    for (const pattern of this.TAKE_PROFIT_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  private static extractTrailing(input: string): string | undefined {
    for (const pattern of this.TRAILING_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return undefined;
  }

  private static extractOrderType(input: string): 'MARKET' | 'LIMIT' | undefined {
    for (const pattern of this.ORDER_TYPE_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        const type = match[1].toLowerCase();
        if (type === 'market' || type === 'mkt' || type === 'm') {
          return 'MARKET';
        } else if (type === 'limit' || type === 'lmt' || type === 'l') {
          return 'LIMIT';
        }
      }
    }
    return undefined;
  }

  private static extractReduceOnly(input: string): boolean {
    for (const pattern of this.REDUCE_PATTERNS) {
      if (pattern.test(input)) {
        return true;
      }
    }
    return false;
  }

  // Generate example commands
  static generateExamples(): string[] {
    return [
      '/buy BTCUSDT 100u x5 sl1% tp3%',
      '/sell ETHUSDT 0.25 x3 reduce',
      '/buy SOLUSDT mkt 250u tp2%',
      '/sell ADAUSDT limit 1000u x2 sl2% tp5%',
      '/buy LINKUSDT 50u x10 trail1%',
    ];
  }

  // Validate symbol format
  static isValidSymbol(symbol: string): boolean {
    return /^[A-Z]{2,10}USDT?$/.test(symbol);
  }

  // Parse size with unit detection
  static parseSize(sizeStr: string): { amount: number; isQuote: boolean } {
    const quoteMatch = sizeStr.match(/(\d+(?:\.\d+)?)(?:u|usdt|usd|busd)/i);
    if (quoteMatch) {
      return {
        amount: parseFloat(quoteMatch[1]),
        isQuote: true,
      };
    }

    const amount = parseFloat(sizeStr);
    if (isNaN(amount) || amount <= 0) {
      throw new Error(`Invalid size: ${sizeStr}`);
    }

    return {
      amount,
      isQuote: false,
    };
  }
}

export class TradePreviewGenerator {
  private filtersManager: FiltersManager;
  private priceProtection: PriceProtectionManager;

  constructor(filtersManager: FiltersManager, priceProtection: PriceProtectionManager) {
    this.filtersManager = filtersManager;
    this.priceProtection = priceProtection;
  }

  async generatePreview(
    command: TradeCommand,
    orderBook: OrderBookDepth,
    userSettings: UserSettings,
    markPrice?: string
  ): Promise<PreviewResult> {
    try {
      const errors: string[] = [];
      const warnings: string[] = [];

      // Validate symbol filters exist
      const symbolFilters = this.filtersManager.getSymbolFilters(command.symbol);
      if (!symbolFilters) {
        return {
          success: false,
          errors: [`Symbol ${command.symbol} not supported or filters not loaded`],
          warnings: [],
        };
      }

      // Calculate base and quote sizes
      const { baseSize, quoteSize, estimatedPrice } = await this.calculateSizes(
        command,
        orderBook,
        markPrice
      );

      // Apply leverage
      const leverage = command.leverage || userSettings.default_leverage;
      if (leverage > userSettings.leverage_cap) {
        errors.push(`Leverage ${leverage}x exceeds your cap of ${userSettings.leverage_cap}x`);
      }

      // Validate order parameters
      const validation = this.filtersManager.validateOrder(
        command.symbol,
        estimatedPrice,
        baseSize,
        command.orderType || 'MARKET',
        command.reduceOnly || false
      );

      if (!validation.isValid) {
        errors.push(...validation.errors);
      }

      if (validation.adjustedPrice) {
        warnings.push(`Price adjusted to ${validation.adjustedPrice}`);
      }

      if (validation.adjustedQuantity) {
        warnings.push(`Quantity adjusted to ${validation.adjustedQuantity}`);
      }

      // Check price protection for market orders
      let slippageWarning = false;
      let maxSlippageExceeded = false;

      if (command.orderType === 'MARKET') {
        const protection = await this.priceProtection.analyzeMarketOrder(
          command.symbol,
          command.action,
          baseSize,
          orderBook,
          userSettings
        );

        if (protection.recommendation === 'WARNING') {
          slippageWarning = true;
          warnings.push(...protection.warnings);
        } else if (protection.recommendation === 'REJECT') {
          maxSlippageExceeded = true;
          errors.push(...protection.warnings);
        }
      }

      // Estimate fees
      const estimatedFees = this.calculateEstimatedFees(parseFloat(quoteSize));

      const preview: TradePreview = {
        command,
        symbol: command.symbol,
        side: command.action,
        baseSize: validation.adjustedQuantity || baseSize,
        quoteSize,
        leverage,
        estimatedPrice: validation.adjustedPrice || estimatedPrice,
        estimatedFees,
        slippageWarning,
        maxSlippageExceeded,
      };

      return {
        success: errors.length === 0,
        preview: errors.length === 0 ? preview : undefined,
        errors,
        warnings,
      };

    } catch (error) {
      return {
        success: false,
        errors: [`Preview generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings: [],
      };
    }
  }

  private async calculateSizes(
    command: TradeCommand,
    orderBook: OrderBookDepth,
    markPrice?: string
  ): Promise<{ baseSize: string; quoteSize: string; estimatedPrice: string }> {
    let estimatedPrice: number;

    // Get estimated execution price
    if (command.orderType === 'LIMIT' && command.price) {
      estimatedPrice = parseFloat(command.price);
    } else {
      // Use best bid/ask for market orders
      const orders = command.action === 'BUY' ? orderBook.asks : orderBook.bids;
      if (orders.length === 0) {
        throw new Error('No liquidity available');
      }
      estimatedPrice = parseFloat(orders[0][0]);
    }

    let baseSize: number;
    let quoteSize: number;

    if (command.sizeType === 'QUOTE') {
      // Convert quote to base
      quoteSize = parseFloat(command.size!);
      baseSize = PriceUtils.quoteToBase(quoteSize, estimatedPrice);
    } else {
      // Base size provided
      baseSize = parseFloat(command.size!);
      quoteSize = PriceUtils.baseToQuote(baseSize, estimatedPrice);
    }

    // Round to appropriate precision
    const symbolFilters = this.filtersManager.getSymbolFilters(command.symbol);
    if (symbolFilters) {
      baseSize = parseFloat(symbolFilters.roundQuantity(baseSize));
      estimatedPrice = parseFloat(symbolFilters.roundPrice(estimatedPrice));
      quoteSize = PriceUtils.baseToQuote(baseSize, estimatedPrice);
    }

    return {
      baseSize: baseSize.toString(),
      quoteSize: quoteSize.toFixed(2),
      estimatedPrice: estimatedPrice.toString(),
    };
  }

  private calculateEstimatedFees(notional: number): string {
    // Typical maker/taker fees are around 0.02% to 0.04%
    const feeRate = 0.0004; // 0.04%
    const fees = notional * feeRate;
    return fees.toFixed(2);
  }

  formatPreviewForDisplay(preview: TradePreview): string {
    const lines: string[] = [];
    
    const action = preview.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    lines.push(`${action} ${preview.symbol}`);
    
    lines.push('');
    lines.push(`📊 **Order Details**`);
    lines.push(`• Size: ${preview.baseSize} (≈ $${preview.quoteSize})`);
    lines.push(`• Leverage: ${preview.leverage}x`);
    lines.push(`• Est. Price: $${preview.estimatedPrice}`);
    lines.push(`• Est. Fees: $${preview.estimatedFees}`);
    
    if (preview.command.stopLoss) {
      const slPrice = PriceUtils.calculateStopLoss(
        parseFloat(preview.estimatedPrice),
        parseFloat(preview.command.stopLoss),
        preview.side
      );
      lines.push(`• Stop Loss: ${preview.command.stopLoss}% ($${slPrice.toFixed(4)})`);
    }
    
    if (preview.command.takeProfit) {
      const tpPrice = PriceUtils.calculateTakeProfit(
        parseFloat(preview.estimatedPrice),
        parseFloat(preview.command.takeProfit),
        preview.side
      );
      lines.push(`• Take Profit: ${preview.command.takeProfit}% ($${tpPrice.toFixed(4)})`);
    }

    if (preview.command.reduceOnly) {
      lines.push('• **Reduce Only**: This will only reduce your position');
    }

    if (preview.slippageWarning) {
      lines.push('');
      lines.push('⚠️ **Slippage Warning**: Higher than usual slippage expected');
    }

    if (preview.maxSlippageExceeded) {
      lines.push('');
      lines.push('❌ **High Slippage**: Consider reducing order size');
    }

    return lines.join('\n');
  }
}