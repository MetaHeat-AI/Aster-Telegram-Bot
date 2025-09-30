import { Markup } from 'telegraf';
import { BaseHandler, BotContext } from './BaseHandler';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export class NavigationHandler extends BaseHandler {
  constructor(eventEmitter: BotEventEmitter) {
    super(eventEmitter);
  }

  async showWelcomeMessage(ctx: BotContext): Promise<void> {
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        const welcomeText = `
**StableSolid** — The First & Fastest **AsterDEX** Trading Bot & Terminal

Trade spot and perpetuals on **AsterDEX** instantly, right from Telegram. **Zero fees, full control, and a smooth, user-friendly interface** make trading effortless, fast, and secure.

**Core Features**

**Fast & Intuitive UX** Telegram-native interface for seamless on-the-go trades
**Secure & Private** Your account and keys are fully under your control
**Spot & Perps** All AsterDEX markets with leverage
**Advanced Risk Tools** TP/SL/DCA for professional risk management
**Live P&L & Natural Commands** Track and trade in real time
**Zero Hidden Fees** Keep 100% of your profits
…& much more

🎁 **Beta Bonus:** Join the StableSolid beta group for exclusive rewards, DM StableSolid for access and custom invites.

**Choose an action below to get started:**
        `.trim();

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('Secure Connect', 'link_api'),
            Markup.button.callback('Help', 'help')
          ],
          [
            Markup.button.callback('Trade', 'unified_trade'),
            Markup.button.callback('Functions', 'show_commands')
          ]
        ]);
        
        await this.emitNavigation(ctx, 'unknown', 'welcome');
        
        try {
          await ctx.editMessageText(welcomeText, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...keyboard 
          });
        } catch (error) {
          await ctx.reply(welcomeText, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
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
          to: 'welcome'
        });
      },
      'Failed to show welcome message'
    );
  }

  async showMainMenu(ctx: BotContext): Promise<void> {
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        const menuText = `
**StableSolid Trading Dashboard**

Your trading control center for AsterDEX. Execute trades, monitor portfolio, and manage risk from Telegram.

**Select your action:**
        `.trim();

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('Secure Connect', 'link_api'),
            Markup.button.callback('Help', 'help')
          ],
          [
            Markup.button.callback('Trade', 'unified_trade'),
            Markup.button.callback('Functions', 'show_commands')
          ]
        ]);
        
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
**Trading Suite**

Execute trades instantly with smart slippage protection and real-time position management.

**Spot Trading:**
Direct asset ownership with no liquidation risk. Instant execution with best market prices.

**Perpetual Futures:**
Leveraged trading up to 125x leverage. Long and short any market direction with advanced risk management.

**Portfolio Tools:**
Real-time P&L tracking, position management, and balance monitoring.

**Select your action:**
        `.trim();

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('Spot Trading', 'trade_spot'),
            Markup.button.callback('Perps Trading', 'trade_perps')
          ],
          [
            Markup.button.callback('View Positions', 'positions'),
            Markup.button.callback('Check Balance', 'balance')
          ],
          [
            Markup.button.callback('Back to Home', 'back_to_home')
          ]
        ]);

        await this.emitNavigation(ctx, 'main_menu', 'trading_menu');
        
        try {
          await ctx.editMessageText(tradeText, { 
            parse_mode: 'Markdown', 
            ...keyboard 
          });
        } catch (error) {
          await ctx.reply(tradeText, { 
            parse_mode: 'Markdown', 
            ...keyboard 
          });
        }
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
        Markup.button.callback('📊 Prices', 'price_menu'),
        Markup.button.callback('📈 P&L Analysis', 'pnl_analysis')
      ],
      [
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