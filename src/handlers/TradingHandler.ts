import { Markup } from 'telegraf';
import { BaseHandler, BotContext } from './BaseHandler';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';
import { AsterApiClient } from '../aster';

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

  constructor(dependencies: TradingHandlerDependencies) {
    super(dependencies.eventEmitter);
    this.apiClientService = dependencies.apiClientService;
    this.priceService = dependencies.priceService;
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

        const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
        const availableUsdt = await this.getSpotBalance(apiClient, ctx);

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

        const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
        const accountInfo = await apiClient.getAccountInfo();
        const availableBalance = parseFloat(accountInfo.availableBalance || '0');

        if (customSymbol) {
          await this.showCustomPerpsInterface(ctx, customSymbol, availableBalance);
        } else {
          await this.showPerpsTradingInterface(ctx, availableBalance, accountInfo);
        }

        await this.emitNavigation(ctx, 'trading_menu', 'perps_trading', { customSymbol });
      },
      'Failed to load perps trading interface',
      { customSymbol }
    );
  }

  private async getSpotBalance(apiClient: AsterApiClient, ctx: BotContext): Promise<number> {
    try {
      const accountInfo = await apiClient.getSpotAccount();
      const usdtBalance = accountInfo.balances.find((b: any) => b.asset === 'USDT');
      const balance = usdtBalance ? parseFloat(usdtBalance.free) : 0;
      
      await this.emitApiCall(ctx, '/api/v3/account', 'GET', true);
      return balance;
    } catch (spotError) {
      console.warn('[TradingHandler] Spot API failed, trying futures fallback:', spotError);
      
      try {
        const futuresAccount = await apiClient.getAccountInfo();
        const balance = parseFloat(futuresAccount.availableBalance || '0');
        
        await this.emitApiCall(ctx, '/fapi/v1/account', 'GET', true);
        return balance;
      } catch (futuresError) {
        await this.emitApiCall(ctx, '/fapi/v1/account', 'GET', false);
        console.error('[TradingHandler] Both APIs failed:', futuresError);
        return 0;
      }
    }
  }

  private async showSpotTradingInterface(ctx: BotContext, availableUsdt: number): Promise<void> {
    const spotText = `
🏪 **Spot Trading Interface**

💰 **Available USDT:** $${availableUsdt.toFixed(2)}

**Popular Pairs:**
• BTCUSDT - Bitcoin
• ETHUSDT - Ethereum
• SOLUSDT - Solana

**Quick Actions:**
    `.trim();

    const keyboard = Markup.inlineKeyboard([
      // Popular Coins (Clean 2x2 grid)
      [
        Markup.button.callback('₿ Bitcoin', 'spot_buy_BTCUSDT'),
        Markup.button.callback('⟠ Ethereum', 'spot_buy_ETHUSDT')
      ],
      [
        Markup.button.callback('◎ Solana', 'spot_buy_SOLUSDT'),
        Markup.button.callback('🪙 Aster', 'spot_buy_ASTERUSDT')
      ],
      // Actions
      [
        Markup.button.callback('🎯 Custom Pair', 'spot_custom_pair')
      ],
      [
        Markup.button.callback('💱 Sell Assets', 'spot_sell_menu')
      ],
      [
        Markup.button.callback('💰 Balance', 'balance')
      ],
      // Navigation
      [
        Markup.button.callback('⚡ Switch to Perps', 'trade_perps'),
        Markup.button.callback('🔙 Back', 'unified_trade')
      ]
    ]);

    try {
      await ctx.editMessageText(spotText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      await ctx.reply(spotText, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  private async showPerpsTradingInterface(
    ctx: BotContext, 
    availableBalance: number, 
    accountInfo: any
  ): Promise<void> {
    const totalWallet = parseFloat(accountInfo.totalWalletBalance || '0');
    
    const perpsText = `
⚡ **Perps Trading Interface**

💰 **Available Balance:** $${availableBalance.toFixed(2)}
📊 **Total Wallet:** $${totalWallet.toFixed(2)}

**Popular Perps:**
• BTCUSDT - Bitcoin Perpetual
• ETHUSDT - Ethereum Perpetual
• SOLUSDT - Solana Perpetual

**Quick Actions:**
    `.trim();

    const keyboard = Markup.inlineKeyboard([
      // Popular Perps
      [
        Markup.button.callback('📈 Long BTC', 'perps_buy_BTCUSDT'),
        Markup.button.callback('📉 Short BTC', 'perps_sell_BTCUSDT')
      ],
      [
        Markup.button.callback('📈 Long ETH', 'perps_buy_ETHUSDT'),
        Markup.button.callback('📉 Short ETH', 'perps_sell_ETHUSDT')
      ],
      [
        Markup.button.callback('📈 Long SOL', 'perps_buy_SOLUSDT'),
        Markup.button.callback('📉 Short SOL', 'perps_sell_SOLUSDT')
      ],
      // Actions
      [
        Markup.button.callback('🎯 Custom Pair', 'perps_custom_pair')
      ],
      [
        Markup.button.callback('📊 Positions', 'positions')
      ],
      [
        Markup.button.callback('💰 Balance', 'balance')
      ],
      // Navigation
      [
        Markup.button.callback('🏪 Switch to Spot', 'trade_spot'),
        Markup.button.callback('🔙 Back', 'unified_trade')
      ]
    ]);

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