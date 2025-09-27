import { Markup } from 'telegraf';
import { BaseHandler, BotContext } from './BaseHandler';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export class NavigationHandler extends BaseHandler {
  constructor(eventEmitter: BotEventEmitter) {
    super(eventEmitter);
  }

  async showMainMenu(ctx: BotContext): Promise<void> {
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        const menuText = `
🏠 **Main Menu**

Welcome to Aster DEX Trading Bot! Choose an option below:

📈 **Trading** - Access spot and perpetual futures trading
💰 **Portfolio** - View balances, positions, and P&L
⚙️ **Setup** - Configure API keys and settings
📖 **Help** - Get support and documentation
        `.trim();

        const keyboard = this.getMainMenuKeyboard();
        
        await this.emitNavigation(ctx, 'unknown', 'main_menu');
        
        try {
          await ctx.editMessageText(menuText, { 
            parse_mode: 'Markdown', 
            ...keyboard 
          });
        } catch (error) {
          await ctx.reply(menuText, { 
            parse_mode: 'Markdown', 
            ...keyboard 
          });
        }

        this.eventEmitter.emitEvent({
          type: EventTypes.INTERFACE_LOADED,
          timestamp: new Date(),
          userId: ctx.userState?.userId || 0,
          telegramId: ctx.userState?.telegramId || ctx.from?.id || 0,
          correlationId: ctx.correlationId,
          from: 'unknown',
          to: 'main_menu'
        });
      },
      'Failed to show main menu'
    );
  }

  async showTradingMenu(ctx: BotContext): Promise<void> {
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        if (!ctx.userState?.isLinked) {
          await ctx.reply('❌ Please link your API credentials first using /link');
          return;
        }

        const tradeText = `
📈 **Choose Trading Mode**

**🏪 Spot Trading:**
• Trade real assets (BTC, ETH, etc.)
• No leverage, direct ownership
• Perfect for long-term holding

**⚡ Perps Trading:**
• Leveraged perpetual futures
• Up to 125x leverage available
• Long and short positions

Select your preferred trading mode:
        `.trim();

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🏪 Spot Trading', 'trade_spot'),
            Markup.button.callback('⚡ Perps Trading', 'trade_perps')
          ],
          [
            Markup.button.callback('📊 View Positions', 'positions'),
            Markup.button.callback('💰 Check Balance', 'balance')
          ],
          [
            Markup.button.callback('📈 P&L Analysis', 'pnl_analysis')
          ],
          this.getBackNavigation('main_menu')
        ]);

        await this.emitNavigation(ctx, 'main_menu', 'trading_menu');
        await ctx.reply(tradeText, { parse_mode: 'Markdown', ...keyboard });
      },
      'Failed to show trading menu'
    );
  }

  // Helper methods for consistent navigation
  private getMainMenuKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📈 Trade', 'unified_trade')
      ],
      [
        Markup.button.callback('💰 Balance', 'balance'),
        Markup.button.callback('📊 Positions', 'positions')
      ],
      [
        Markup.button.callback('📈 P&L Analysis', 'pnl_analysis'),
        Markup.button.callback('⚙️ Settings', 'settings')
      ],
      [
        Markup.button.callback('🔗 Link API', 'link_api'),
        Markup.button.callback('📖 Help', 'help')
      ]
    ]);
  }

  private getBackNavigation(backAction: string, showHome: boolean = true): any[] {
    const buttons = [Markup.button.callback('🔙 Back', backAction)];
    if (showHome) {
      buttons.push(Markup.button.callback('🏠 Home', 'main_menu'));
    }
    return buttons;
  }

  getTradingNavigation(currentMode: 'spot' | 'perps'): any[] {
    return [
      currentMode === 'spot' 
        ? [Markup.button.callback('⚡ Switch to Perps', 'trade_perps')]
        : [Markup.button.callback('🏪 Switch to Spot', 'trade_spot')],
      this.getBackNavigation('unified_trade')
    ];
  }
}