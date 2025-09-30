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
StableSolid — The First & Fastest AsterDEX Trading Bot & Terminal

Trade spot and perpetuals on AsterDEX instantly, right from Telegram. Zero fees, full control, and a smooth, user-friendly interface make trading effortless, fast, and secure.

Core Features

Fast & Intuitive UX Telegram-native interface for seamless on-the-go trades
Secure & Private Your account and keys are fully under your control
Spot & Perps All AsterDEX markets with leverage
Advanced Risk Tools TP/SL/DCA for professional risk management
Live P&L & Natural Commands Track and trade in real time
Zero Hidden Fees Keep 100% of your profits
…& much more

🎁 Beta Bonus: Join the StableSolid beta group for exclusive rewards, DM StableSolid for access and custom invites.

Choose an action below to get started:
        `.trim();

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🚀 Get Started', 'main_menu'),
            Markup.button.callback('🔗 Link API', 'link_api')
          ],
          [
            Markup.button.callback('💹 Trade Now', 'unified_trade'),
            Markup.button.callback('💼 Portfolio', 'portfolio')
          ],
          [
            Markup.button.callback('📊 Market Prices', 'prices'),
            Markup.button.callback('⚙️ Settings', 'settings')
          ],
          [
            Markup.button.callback('📖 Help & Guide', 'help'),
            Markup.button.callback('ℹ️ Commands', 'show_commands')
          ]
        ]);
        
        await this.emitNavigation(ctx, 'unknown', 'welcome');
        
        await ctx.reply(welcomeText, { 
          ...keyboard 
        });

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
🏠 **AsterBot Main Dashboard**

Your complete trading control center for Aster DEX. Execute professional trades, monitor your portfolio performance, and manage risk — all from Telegram.

**🚀 Quick Actions:**
• **Trade** — Instant spot & futures execution with smart slippage protection
• **Portfolio** — Real-time P&L tracking and position management  
• **Prices** — Live market data, volume leaders, and watchlists
• **Settings** — Configure risk limits, presets, and security features
• **Help** — Guides, support, and feature documentation

**Select your next action:**
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
📈 **Professional Trading Suite**

Execute trades instantly with institutional-grade execution, smart slippage protection, and real-time position management. Choose your preferred trading mode below.

**🏪 Spot Trading:**
• Direct asset ownership (BTC, ETH, ASTER, etc.)
• No liquidation risk, perfect for HODLing
• Instant execution with best market prices
• Custom amounts and percentage-based sizing

**⚡ Perpetual Futures:**
• Leveraged trading up to 125x leverage
• Long and short any market direction
• Cross and isolated margin modes
• Advanced risk management tools

**📊 Portfolio Tools:**
• Real-time P&L tracking and analysis
• Position management with partial closes
• Balance monitoring across all assets

**Select your action:**
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