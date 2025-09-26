import { Markup } from 'telegraf';
import { BaseHandler, BotContext } from './BaseHandler';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';
import { AsterApiClient } from '../aster';
import { SymbolService } from '../services/SymbolService';
import { SpotAccountService } from '../services/SpotAccountService';
import { FuturesAccountService } from '../services/FuturesAccountService';

export interface TradingHandlerDependencies {
  eventEmitter: BotEventEmitter;
  apiClientService: ApiClientService;
  priceService: PriceService;
}

// Interface for API client service
export interface ApiClientService {
  getOrCreateClient(userId: number): Promise<AsterApiClient>;
  validateClient(client: AsterApiClient): Promise<boolean>;
}

// Interface for price service
export interface PriceService {
  getCurrentPrice(symbol: string): Promise<number>;
  validateSymbol(symbol: string): Promise<boolean>;
}

export class TradingHandler extends BaseHandler {
  private apiClientService: ApiClientService;
  private priceService: PriceService;
  private symbolService: SymbolService | null = null;
  private spotAccountService: SpotAccountService | null = null;
  private futuresAccountService: FuturesAccountService | null = null;

  constructor(dependencies: TradingHandlerDependencies) {
    super(dependencies.eventEmitter);
    this.apiClientService = dependencies.apiClientService;
    this.priceService = dependencies.priceService;
  }

  private async getSymbolService(userId: number): Promise<SymbolService> {
    if (!this.symbolService) {
      const apiClient = await this.apiClientService.getOrCreateClient(userId);
      this.symbolService = new SymbolService(apiClient);
    }
    return this.symbolService;
  }

  private async getSpotAccountService(userId: number): Promise<SpotAccountService> {
    if (!this.spotAccountService) {
      const apiClient = await this.apiClientService.getOrCreateClient(userId);
      this.spotAccountService = new SpotAccountService(apiClient);
    }
    return this.spotAccountService;
  }

  private async getFuturesAccountService(userId: number): Promise<FuturesAccountService> {
    if (!this.futuresAccountService) {
      const apiClient = await this.apiClientService.getOrCreateClient(userId);
      this.futuresAccountService = new FuturesAccountService(apiClient);
    }
    return this.futuresAccountService;
  }

  async handleSpotTrading(ctx: BotContext, customSymbol?: string): Promise<void> {
    const correlationId = this.getCorrelationId(ctx);
    
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        if (!ctx.userState?.isLinked) {
          await ctx.reply('❌ Please link your API credentials first using /link');
          return;
        }

        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_INITIATED,
          timestamp: new Date(),
          userId: ctx.userState.userId,
          telegramId: ctx.userState.telegramId,
          correlationId,
          symbol: customSymbol || 'SPOT_MENU',
          action: 'BUY' // Default for spot interface
        });

        const spotAccountService = await this.getSpotAccountService(ctx.userState.userId);
        const availableUsdt = await spotAccountService.getUsdtBalance();

        if (customSymbol) {
          await this.showCustomSpotInterface(ctx, customSymbol, availableUsdt);
        } else {
          await this.showSpotTradingInterface(ctx, availableUsdt);
        }

        await this.emitNavigation(ctx, 'trading_menu', 'spot_trading', { customSymbol });
      },
      'Failed to load spot trading interface',
      { customSymbol }
    );
  }

  async handlePerpsTrading(ctx: BotContext, customSymbol?: string): Promise<void> {
    const correlationId = this.getCorrelationId(ctx);
    
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        if (!ctx.userState?.isLinked) {
          await ctx.reply('❌ Please link your API credentials first using /link');
          return;
        }

        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_INITIATED,
          timestamp: new Date(),
          userId: ctx.userState.userId,
          telegramId: ctx.userState.telegramId,
          correlationId,
          symbol: customSymbol || 'PERPS_MENU',
          action: 'BUY' // Default for perps interface
        });

        const futuresAccountService = await this.getFuturesAccountService(ctx.userState.userId);
        const availableBalance = await futuresAccountService.getAvailableBalance();

        if (customSymbol) {
          await this.showCustomPerpsInterface(ctx, customSymbol, availableBalance);
        } else {
          const portfolioSummary = await futuresAccountService.getPortfolioSummary();
          await this.showPerpsTradingInterface(ctx, availableBalance, portfolioSummary);
        }

        await this.emitNavigation(ctx, 'trading_menu', 'perps_trading', { customSymbol });
      },
      'Failed to load perps trading interface',
      { customSymbol }
    );
  }


  private async showSpotTradingInterface(ctx: BotContext, availableUsdt: number): Promise<void> {
    const symbolService = await this.getSymbolService(ctx.userState!.userId);
    const topSpotSymbols = await symbolService.getTopSymbolsByVolume(4, 'spot');

    let spotText = `
🏪 **Spot Trading Interface**

💰 **Available USDT:** $${availableUsdt.toFixed(2)}

**Top Spot Pairs:**`;

    // Add top symbols to text
    topSpotSymbols.slice(0, 3).forEach(symbol => {
      const emoji = symbolService.getSymbolEmoji(symbol.symbol);
      const name = symbolService.getCleanSymbolName(symbol.symbol);
      const price = parseFloat(symbol.lastPrice).toFixed(4);
      const change = parseFloat(symbol.priceChangePercent).toFixed(2);
      const changeEmoji = parseFloat(symbol.priceChangePercent) >= 0 ? '🟢' : '🔴';
      spotText += `\n• ${emoji} ${symbol.symbol} - $${price} ${changeEmoji}${change}%`;
    });

    spotText += `\n\n**Quick Actions:**`;

    const keyboardRows = [];

    // Create buttons from top symbols (2x2 grid)
    const buttonSymbols = topSpotSymbols.slice(0, 4);
    for (let i = 0; i < buttonSymbols.length; i += 2) {
      const row = [];
      
      if (buttonSymbols[i]) {
        const symbol = buttonSymbols[i];
        const emoji = symbolService.getSymbolEmoji(symbol.symbol);
        const name = symbolService.getCleanSymbolName(symbol.symbol);
        row.push(Markup.button.callback(`${emoji} ${name}`, `spot_buy_${symbol.symbol}`));
      }
      
      if (buttonSymbols[i + 1]) {
        const symbol = buttonSymbols[i + 1];
        const emoji = symbolService.getSymbolEmoji(symbol.symbol);
        const name = symbolService.getCleanSymbolName(symbol.symbol);
        row.push(Markup.button.callback(`${emoji} ${name}`, `spot_buy_${symbol.symbol}`));
      }
      
      keyboardRows.push(row);
    }

    // Add action buttons
    keyboardRows.push([
      Markup.button.callback('🎯 Custom Pair', 'spot_custom_pair')
    ]);
    keyboardRows.push([
      Markup.button.callback('💱 Sell Assets', 'spot_sell_menu')
    ]);
    keyboardRows.push([
      Markup.button.callback('🏦 My Assets', 'spot_assets'),
      Markup.button.callback('💰 Balance', 'balance')
    ]);

    // Navigation
    keyboardRows.push([
      Markup.button.callback('⚡ Switch to Perps', 'trade_perps'),
      Markup.button.callback('🔙 Back', 'unified_trade')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardRows);

    try {
      await ctx.editMessageText(spotText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      await ctx.reply(spotText, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  private async showPerpsTradingInterface(
    ctx: BotContext, 
    availableBalance: number, 
    portfolioSummary: any
  ): Promise<void> {
    const totalWallet = portfolioSummary.totalWalletBalance;
    const symbolService = await this.getSymbolService(ctx.userState!.userId);
    const topFuturesSymbols = await symbolService.getTopSymbolsByVolume(3, 'futures');

    let perpsText = `
⚡ **Perps Trading Interface**

💰 **Available Balance:** $${availableBalance.toFixed(2)}
📊 **Total Wallet:** $${totalWallet.toFixed(2)}

**Top Futures Pairs:**`;

    // Add top symbols to text
    topFuturesSymbols.forEach(symbol => {
      const emoji = symbolService.getSymbolEmoji(symbol.symbol);
      const name = symbolService.getCleanSymbolName(symbol.symbol);
      const price = parseFloat(symbol.lastPrice).toFixed(4);
      const change = parseFloat(symbol.priceChangePercent).toFixed(2);
      const changeEmoji = parseFloat(symbol.priceChangePercent) >= 0 ? '🟢' : '🔴';
      perpsText += `\n• ${emoji} ${symbol.symbol} - $${price} ${changeEmoji}${change}%`;
    });

    perpsText += `\n\n**Quick Actions:**`;

    const keyboardRows = [];

    // Create long/short buttons for top symbols
    topFuturesSymbols.slice(0, 3).forEach(symbol => {
      const emoji = symbolService.getSymbolEmoji(symbol.symbol);
      const name = symbolService.getCleanSymbolName(symbol.symbol);
      keyboardRows.push([
        Markup.button.callback(`📈 Long ${name}`, `perps_buy_${symbol.symbol}`),
        Markup.button.callback(`📉 Short ${name}`, `perps_sell_${symbol.symbol}`)
      ]);
    });

    // Add action buttons
    keyboardRows.push([
      Markup.button.callback('🎯 Custom Pair', 'perps_custom_pair')
    ]);
    keyboardRows.push([
      Markup.button.callback('📊 Positions', 'positions')
    ]);
    keyboardRows.push([
      Markup.button.callback('💰 Balance', 'balance')
    ]);

    // Navigation
    keyboardRows.push([
      Markup.button.callback('🏪 Switch to Spot', 'trade_spot'),
      Markup.button.callback('🔙 Back', 'unified_trade')
    ]);

    const keyboard = Markup.inlineKeyboard(keyboardRows);

    try {
      await ctx.editMessageText(perpsText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      await ctx.reply(perpsText, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  private async showCustomSpotInterface(
    ctx: BotContext, 
    symbol: string, 
    availableUsdt: number
  ): Promise<void> {
    const currentPrice = await this.priceService.getCurrentPrice(symbol);
    const baseAsset = symbol.replace('USDT', '');
    
    const spotText = `
🏪 **Spot Trading: ${symbol}**

💰 **Available USDT:** $${availableUsdt.toFixed(2)}
💹 **Current Price:** $${currentPrice.toFixed(6)}

**${baseAsset} Spot Trading:**
• Trade real assets with no leverage
• Direct ownership of tokens
• Perfect for long-term holding

**Quick Actions:**
    `.trim();

    const keyboard = Markup.inlineKeyboard([
      // Quick Buy Actions
      [
        Markup.button.callback('🟢 $25', `spot_execute_buy_${symbol}_25u`),
        Markup.button.callback('🟢 $50', `spot_execute_buy_${symbol}_50u`)
      ],
      [
        Markup.button.callback('🟢 $100', `spot_execute_buy_${symbol}_100u`),
        Markup.button.callback('🟢 $250', `spot_execute_buy_${symbol}_250u`)
      ],
      // Custom Actions
      [
        Markup.button.callback('💰 Custom Buy', `spot_custom_amount_buy_${symbol}`)
      ],
      [
        Markup.button.callback(`🔴 Sell ${baseAsset}`, `spot_custom_amount_sell_${symbol}`)
      ],
      // Navigation
      [
        Markup.button.callback('⚡ Switch to Perps', 'trade_perps'),
        Markup.button.callback('🔙 Back', 'trade_spot')
      ]
    ]);

    await ctx.reply(spotText, { parse_mode: 'Markdown', ...keyboard });
  }

  private async showCustomPerpsInterface(
    ctx: BotContext, 
    symbol: string, 
    availableBalance: number
  ): Promise<void> {
    const currentPrice = await this.priceService.getCurrentPrice(symbol);
    const baseAsset = symbol.replace('USDT', '');
    
    const perpsText = `
⚡ **Perps Trading: ${symbol}**

💰 **Available Balance:** $${availableBalance.toFixed(2)}
💹 **Current Price:** $${currentPrice.toFixed(6)}

**${baseAsset} Perpetual Futures:**
• Leveraged trading up to 125x
• Long and short positions
• Advanced trading features

**Quick Actions:**
    `.trim();

    const keyboard = Markup.inlineKeyboard([
      // Quick Actions
      [
        Markup.button.callback('📈 Long $25 5x', `perps_execute_buy_${symbol}_25u_5x`),
        Markup.button.callback('📉 Short $25 5x', `perps_execute_sell_${symbol}_25u_5x`)
      ],
      [
        Markup.button.callback('📈 Long $50 10x', `perps_execute_buy_${symbol}_50u_10x`),
        Markup.button.callback('📉 Short $50 10x', `perps_execute_sell_${symbol}_50u_10x`)
      ],
      [
        Markup.button.callback('📈 Long $100 5x', `perps_execute_buy_${symbol}_100u_5x`),
        Markup.button.callback('📉 Short $100 5x', `perps_execute_sell_${symbol}_100u_5x`)
      ],
      // Custom Actions
      [
        Markup.button.callback('💰 Custom Long', `perps_custom_amount_buy_${symbol}`)
      ],
      [
        Markup.button.callback('💰 Custom Short', `perps_custom_amount_sell_${symbol}`)
      ],
      // Navigation
      [
        Markup.button.callback('🏪 Switch to Spot', 'trade_spot'),
        Markup.button.callback('🔙 Back', 'trade_perps')
      ]
    ]);

    await ctx.reply(perpsText, { parse_mode: 'Markdown', ...keyboard });
  }
}