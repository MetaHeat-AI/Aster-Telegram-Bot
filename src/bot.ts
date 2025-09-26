import dotenv from 'dotenv';
import { Telegraf, Context, Markup } from 'telegraf';
import { Update } from 'telegraf/types';
import express from 'express';

import { BotConfig, BotConfigSchema, UserState, TradeCommand, OrderBookDepth, NewOrderRequest } from './types';
import { DatabaseManager } from './db';
import { EncryptionManager } from './encryption';
import { AsterApiClient } from './aster';
import { FiltersManager } from './filters';
import { PriceProtectionManager } from './priceguard';
import { SettingsManager } from './settings';
import { TradeParser, TradePreviewGenerator } from './tradeparser';
import { NotificationManager } from './notifications';
import { PnLCalculator } from './pnl';

// Load environment variables
dotenv.config();

interface BotContext extends Context<Update> {
  userState?: UserState;
}

class AsterTradingBot {
  private bot: Telegraf<BotContext>;
  private config: BotConfig;
  private db: DatabaseManager;
  private encryption: EncryptionManager;
  private filtersManager: FiltersManager;
  private priceProtection: PriceProtectionManager;
  private settingsManager: SettingsManager;
  private tradePreviewGenerator: TradePreviewGenerator;
  private notificationManager: NotificationManager;
  private server: express.Application;
  
  private userSessions = new Map<number, AsterApiClient>();
  private pendingTrades = new Map<number, any>();
  private conversationStates = new Map<number, UserState['conversationState']>();

  constructor() {
    this.config = this.loadConfig();
    this.db = new DatabaseManager(this.config.database.url, this.config.redis?.url);
    this.encryption = new EncryptionManager(this.config.encryption.key);
    this.filtersManager = new FiltersManager();
    this.priceProtection = new PriceProtectionManager(this.filtersManager);
    this.settingsManager = new SettingsManager(this.db, this.encryption);
    this.tradePreviewGenerator = new TradePreviewGenerator(this.filtersManager, this.priceProtection);
    this.notificationManager = new NotificationManager(this.db);

    this.bot = new Telegraf<BotContext>(this.config.telegram.token);
    this.server = express();

    this.setupMiddleware();
    this.setupCommands();
    this.setupActions();
    this.setupServer();
  }

  private async initializeExchangeInfo(): Promise<void> {
    try {
      console.log('[FiltersManager] Loading exchange info...');
      // Create a temporary API client to get exchange info
      const tempClient = new AsterApiClient(this.config.aster.baseUrl, '', '');
      const exchangeInfo = await tempClient.getExchangeInfo();
      
      console.log(`[FiltersManager] Loaded ${exchangeInfo.symbols.length} symbols`);
      
      // Load filters for all symbols
      for (const symbolInfo of exchangeInfo.symbols) {
        this.filtersManager.loadSymbolFilters(symbolInfo);
      }
      
      console.log('[FiltersManager] Exchange info initialized successfully');
    } catch (error) {
      console.error('[FiltersManager] Failed to load exchange info:', error);
      throw error;
    }
  }

  private loadConfig(): BotConfig {
    const config = {
      telegram: {
        token: process.env.TG_BOT_TOKEN!,
        adminIds: process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) || [],
      },
      aster: {
        baseUrl: process.env.ASTER_BASE_URL || 'https://api.aster.exchange',
        defaultRecvWindow: parseInt(process.env.DEFAULT_RECV_WINDOW || '5000'),
        maxLeverage: parseInt(process.env.MAX_LEVERAGE || '20'),
      },
      database: {
        url: process.env.DATABASE_URL!,
      },
      redis: process.env.REDIS_URL ? {
        url: process.env.REDIS_URL,
      } : undefined,
      encryption: {
        key: process.env.ENCRYPTION_KEY!,
      },
      server: {
        port: parseInt(process.env.PORT || '3000'),
      },
      rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
      },
    };

    return BotConfigSchema.parse(config);
  }

  private setupMiddleware(): void {
    // User state middleware
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return next();

      try {
        let user = await this.db.getUserByTelegramId(ctx.from.id);
        if (!user) {
          user = await this.db.createUser(ctx.from.id);
        }

        const settings = await this.settingsManager.getUserSettings(user.id);
        const credentials = await this.db.getApiCredentials(user.id);

        ctx.userState = {
          userId: user.id,
          telegramId: ctx.from.id,
          isLinked: !!credentials,
          settings,
          conversationState: this.conversationStates.get(user.id), // Get from memory store
        };
      } catch (error) {
        console.error('Middleware error:', error);
        await ctx.reply('❌ Internal error. Please try again.');
        return;
      }

      return next();
    });

    // Rate limiting middleware
    this.bot.use(async (ctx, next) => {
      if (!ctx.userState) return next();

      const rateLimitKey = `ratelimit:${ctx.userState.userId}`;
      const requests = await this.db.incrementRate(rateLimitKey, 60);

      if (requests > this.config.rateLimit.maxRequests) {
        await ctx.reply('⏱️ Rate limit exceeded. Please slow down.');
        return;
      }

      return next();
    });
  }

  private setupCommands(): void {
    // Start command
    this.bot.command('start', async (ctx) => {
      const welcomeText = `
🚀 **Welcome to Aster Trading Bot!**

Professional DEX trading with advanced features:
• 📈 Spot & Perpetual Futures Trading
• 🎯 Take Profit & Stop Loss Management  
• 🛡️ Price Protection & Slippage Control
• 📊 Real-time P&L & Position Monitoring
• 💰 Custom Amount & Natural Language Input
• 🔔 Live Trade Notifications

⚠️ **Risk Disclaimer**: Trading involves significant risk. Only trade with funds you can afford to lose.

Choose an action below to get started:
      `;

      await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...this.getMainMenuKeyboard() });
    });

    // Menu command  
    this.bot.command('menu', async (ctx) => {
      await this.showMainMenu(ctx);
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      await this.handleHelpCommand(ctx);
    });

    // Link command
    this.bot.command('link', async (ctx) => {
      await this.handleLinkFlow(ctx);
    });

    // Unlink command
    this.bot.command('unlink', async (ctx) => {
      if (!ctx.userState?.isLinked) {
        await ctx.reply('❌ No API credentials are currently linked.');
        return;
      }

      const hasPinSet = await this.settingsManager.hasPinSet(ctx.userState.userId);
      
      if (hasPinSet) {
        await ctx.reply('🔐 Please enter your PIN to unlink API credentials:');
        // Store pending unlink action
        // Implementation would handle PIN verification flow
      } else {
        await this.performUnlink(ctx);
      }
    });

    // Settings command
    this.bot.command('settings', async (ctx) => {
      if (!ctx.userState) return;
      
      const settings = await this.settingsManager.getUserSettings(ctx.userState.userId);
      const formattedSettings = this.settingsManager.formatSettingsForDisplay(settings);
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🎚️ Leverage', 'settings_leverage'),
          Markup.button.callback('💰 Size Presets', 'settings_size'),
        ],
        [
          Markup.button.callback('📊 Slippage', 'settings_slippage'),
          Markup.button.callback('🎯 TP/SL Presets', 'settings_tpsl'),
        ],
        [
          Markup.button.callback('💸 Daily Loss Cap', 'settings_daily_cap'),
          Markup.button.callback('🔐 PIN Code', 'settings_pin'),
        ],
        [Markup.button.callback('🔄 Reset Defaults', 'settings_reset')],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')],
      ]);

      await ctx.reply(formattedSettings, { parse_mode: 'Markdown', ...keyboard });
    });

    // Buy command
    this.bot.command('buy', async (ctx) => {
      await this.handleTradeCommand(ctx, 'BUY');
    });

    // Sell command  
    this.bot.command('sell', async (ctx) => {
      await this.handleTradeCommand(ctx, 'SELL');
    });

    // Positions command
    this.bot.command('positions', async (ctx) => {
      await this.handlePositionsCommand(ctx);
    });

    // Balance command
    this.bot.command('balance', async (ctx) => {
      await this.handleBalanceCommand(ctx);
    });

    // P&L command
    this.bot.command('pnl', async (ctx) => {
      await this.handlePnLCommand(ctx);
    });

    // Spot trading command
    this.bot.command('spot', async (ctx) => {
      await this.handleSpotCommand(ctx);
    });

    // Price command
    this.bot.command('price', async (ctx) => {
      const symbol = ctx.message.text.split(' ')[1]?.toUpperCase();
      if (!symbol) {
        await ctx.reply('Please specify a symbol: /price BTCUSDT');
        return;
      }
      
      await this.handlePriceCommand(ctx, symbol);
    });

    // Trade command - unified trading interface with spot/perps selection
    this.bot.command('trade', async (ctx) => {
      await this.handleUnifiedTradeCommand(ctx);
    });

    // Admin panic command
    this.bot.command('panic', async (ctx) => {
      if (!this.config.telegram.adminIds.includes(ctx.from?.id || 0)) {
        return; // Silently ignore non-admin users
      }
      
      await this.handlePanicCommand(ctx);
    });

    // Default text handler for natural language commands and conversation states
    this.bot.on('text', async (ctx) => {
      const text = ctx.message.text.trim();
      
      // Skip commands that start with /
      if (text.startsWith('/')) {
        return;
      }

      // Handle conversation states first
      if (ctx.userState?.conversationState) {
        await this.handleConversationState(ctx, text);
        return;
      }

      try {
        const parseResult = TradeParser.parseTradeCommand(text.toLowerCase());
        
        if (parseResult.success && parseResult.command) {
          await this.handleTradePreview(ctx, parseResult.command);
        } else {
          const errorMsg = parseResult.errors.length > 0 
            ? parseResult.errors[0] 
            : 'I didn\'t understand that.';
          await ctx.reply(`❓ ${errorMsg}\n\nTry commands like:\n• \`buy 0.1 ETH 10x\`\n• \`sell 50u BTC\`\n• \`/help\` for more options`, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        console.error('Trade parsing error:', error);
        await ctx.reply('❌ Error parsing your command. Please try again or use /help for guidance.');
      }
    });
  }

  private setupActions(): void {
    // Link API credentials flow
    this.bot.action('link_api', async (ctx) => {
      await this.handleLinkFlow(ctx);
    });

    // Settings actions
    this.bot.action(/^settings_(.+)$/, async (ctx) => {
      const settingType = ctx.match[1];
      await this.handleSettingsAction(ctx, settingType);
    });

    // Trade confirmation actions
    this.bot.action('confirm_trade', async (ctx) => {
      await this.handleTradeConfirmation(ctx);
    });

    this.bot.action('cancel_trade', async (ctx) => {
      if (!ctx.userState) return;
      
      this.pendingTrades.delete(ctx.userState.userId);
      await ctx.editMessageText('❌ Trade cancelled.');
    });

    // Trading interface actions
    this.bot.action('trade_buy', async (ctx) => {
      await this.handleSymbolSelection(ctx, 'BUY');
    });

    this.bot.action('trade_sell', async (ctx) => {
      await this.handleSymbolSelection(ctx, 'SELL');
    });

    this.bot.action(/^symbol_(.+)_(.+)$/, async (ctx) => {
      const side = ctx.match[1] as 'BUY' | 'SELL';
      const symbol = ctx.match[2];
      await this.handleQuantitySelection(ctx, side, symbol);
    });

    this.bot.action(/^qty_(.+)_(.+)_(.+)$/, async (ctx) => {
      const side = ctx.match[1] as 'BUY' | 'SELL';
      const symbol = ctx.match[2];
      const quantity = ctx.match[3];
      await this.handleLeverageSelection(ctx, side, symbol, quantity);
    });

    this.bot.action(/^lev_(.+)_(.+)_(.+)_(.+)$/, async (ctx) => {
      const side = ctx.match[1] as 'BUY' | 'SELL';
      const symbol = ctx.match[2];
      const quantity = ctx.match[3];
      const leverage = ctx.match[4];
      await this.handleButtonTradeConfirmation(ctx, side, symbol, quantity, leverage);
    });

    this.bot.action('trade_back', async (ctx) => {
      await this.handleTradeInterface(ctx);
    });

    this.bot.action('positions', async (ctx) => {
      await this.handlePositionsCommand(ctx);
    });

    this.bot.action('balance', async (ctx) => {
      await this.handleBalanceCommand(ctx);
    });

    this.bot.action('settings', async (ctx) => {
      await ctx.editMessageText('Settings menu (under construction)');
    });

    // Position management actions
    this.bot.action(/^position_(.+)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      await this.handlePositionAction(ctx, action, symbol);
    });

    // Quick trading actions
    this.bot.action(/^quick_trade_(.+)$/, async (ctx) => {
      const symbol = ctx.match[1];
      await this.showQuickTradingPanel(ctx, symbol);
    });

    // Quick buy/sell actions
    this.bot.action(/^quick_(buy|sell)_(\d+)([up%])_(.+)$/, async (ctx) => {
      const side = ctx.match[1];
      const amount = parseInt(ctx.match[2]);
      const unit = ctx.match[3]; // 'u' for USDT, 'p' for percentage
      const symbol = ctx.match[4];
      await this.handleQuickTrade(ctx, side, amount, unit, symbol);
    });

    // P&L refresh action
    this.bot.action('refresh_pnl', async (ctx) => {
      await this.handlePnLCommand(ctx);
    });

    this.bot.action('pnl_analysis', async (ctx) => {
      await this.handlePnLCommand(ctx);
    });

    // Trade flow selection actions
    this.bot.action('trade_spot', async (ctx) => {
      await this.handleSpotTradingInterface(ctx);
    });

    this.bot.action('trade_perps', async (ctx) => {
      await this.handlePerpsTradingInterface(ctx);
    });

    // Spot trading actions
    this.bot.action(/^spot_(buy|sell)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      await this.handleSpotTradeAction(ctx, action, symbol);
    });

    // Perps trading actions  
    this.bot.action(/^perps_(buy|sell)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      await this.handlePerpsTradeAction(ctx, action, symbol);
    });

    // Back to unified trade menu
    this.bot.action('unified_trade', async (ctx) => {
      await this.handleUnifiedTradeCommand(ctx);
    });

    // Custom pair selection
    this.bot.action('spot_custom_pair', async (ctx) => {
      await this.handleCustomPairSelection(ctx, 'spot');
    });

    this.bot.action('perps_custom_pair', async (ctx) => {
      await this.handleCustomPairSelection(ctx, 'perps');
    });

    // Spot execution actions
    this.bot.action(/^spot_execute_(buy|sell)_(.+)_(\d+)u$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const amount = ctx.match[3];
      await this.executeSpotPresetOrder(ctx, action, symbol, amount);
    });

    // Perps execution actions
    this.bot.action(/^perps_execute_(buy|sell)_(.+)_(\d+)u_(\d+)x$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const amount = ctx.match[3];
      const leverage = ctx.match[4];
      await this.executePerpsPresetOrder(ctx, action, symbol, amount, leverage);
    });

    // Custom amount actions
    this.bot.action(/^spot_custom_amount_(buy|sell)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      await this.handleCustomAmountInput(ctx, 'spot', action, symbol);
    });

    this.bot.action(/^perps_custom_amount_(buy|sell)_(.+)$/, async (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      await this.handleCustomAmountInput(ctx, 'perps', action, symbol);
    });

    // Main menu action
    this.bot.action('main_menu', async (ctx) => {
      await this.showMainMenu(ctx);
    });

    // Help button action
    this.bot.action('help', async (ctx) => {
      await this.handleHelpCommand(ctx);
    });
  }

  private setupServer(): void {
    this.server.use(express.json());
    
    // Health check endpoints (both /health and /healthz for different platforms)
    const healthHandler = async (req: any, res: any) => {
      try {
        const dbHealth = await this.db.healthCheck();
        const health = {
          status: 'ok',
          timestamp: new Date().toISOString(),
          database: dbHealth,
          version: process.env.npm_package_version || '1.0.0'
        };
        
        res.json(health);
      } catch (error) {
        res.status(500).json({
          status: 'error',
          error: 'Health check failed',
        });
      }
    };
    
    this.server.get('/health', healthHandler);
    this.server.get('/healthz', healthHandler);

    this.server.listen(this.config.server.port, () => {
      console.log(`[Server] Listening on port ${this.config.server.port}`);
    });
  }

  private async handleLinkFlow(ctx: BotContext): Promise<void> {
    if (!ctx.userState) return;

    if (ctx.userState.isLinked) {
      await ctx.reply('✅ You already have API credentials linked. Use /unlink to remove them first.');
      return;
    }

    // Set conversation state
    const conversationState = {
      step: 'waiting_api_key' as const,
      data: { pendingAction: 'link' as const }
    };
    ctx.userState.conversationState = conversationState;
    this.conversationStates.set(ctx.userState.userId, conversationState);

    await ctx.reply(`
🔗 **Link Your Aster API Credentials**

To enable trading, please provide your Aster API credentials:

1. Go to Aster exchange settings
2. Create a new API key with trading permissions  
3. Whitelist this bot's IP if possible (recommended)

⚠️ **Security Note**: Your credentials are encrypted and stored securely. Never share them with anyone else.

Please send your **API Key** now:
    `, { parse_mode: 'Markdown' });
  }

  private async handleConversationState(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.userState?.conversationState) return;

    const state = ctx.userState.conversationState;

    try {
      switch (state.step) {
        case 'waiting_api_key':
          await this.handleApiKeyInput(ctx, text);
          break;
        case 'waiting_api_secret':
          await this.handleApiSecretInput(ctx, text);
          break;
        case 'waiting_pin':
          await this.handlePinInput(ctx, text);
          break;
        case 'confirming_unlink':
          await this.handleUnlinkConfirmation(ctx, text);
          break;
        case 'price':
          await this.handlePriceInput(ctx, text);
          break;
        case 'amount':
          await this.handleAmountInput(ctx, text);
          break;
        case 'waiting_custom_pair':
          await this.handleCustomPairInput(ctx, text);
          break;
        case 'waiting_custom_amount':
          await this.handleCustomAmountInputText(ctx, text);
          break;
        default:
          // Clear invalid state
          ctx.userState.conversationState = undefined;
          this.conversationStates.delete(ctx.userState.userId);
          await ctx.reply('❌ Invalid conversation state. Please try again.');
      }
    } catch (error) {
      console.error('Conversation state error:', error);
      ctx.userState.conversationState = undefined;
      this.conversationStates.delete(ctx.userState.userId);
      await ctx.reply('❌ An error occurred. Please try again.');
    }
  }

  private async handleApiKeyInput(ctx: BotContext, apiKey: string): Promise<void> {
    if (!ctx.userState?.conversationState) return;

    // Basic validation
    if (!apiKey || apiKey.length < 10) {
      await ctx.reply('❌ Invalid API key format. Please send a valid API key:');
      return;
    }

    // Store API key temporarily
    const updatedState = {
      step: 'waiting_api_secret' as const,
      data: { ...ctx.userState.conversationState.data, apiKey }
    };
    ctx.userState.conversationState = updatedState;
    this.conversationStates.set(ctx.userState.userId, updatedState);

    await ctx.reply(`✅ API Key received.\n\nNow please send your **API Secret**:`);
  }

  private async handleApiSecretInput(ctx: BotContext, apiSecret: string): Promise<void> {
    if (!ctx.userState?.conversationState?.data?.apiKey) return;

    // Basic validation
    if (!apiSecret || apiSecret.length < 10) {
      await ctx.reply('❌ Invalid API secret format. Please send a valid API secret:');
      return;
    }

    const apiKey = ctx.userState.conversationState.data.apiKey;

    try {
      await ctx.reply('🔄 Validating credentials...');

      // Create API client to test credentials
      const testClient = new AsterApiClient(this.config.aster.baseUrl, apiKey, apiSecret);
      const isValid = await testClient.validateApiCredentials();

      if (!isValid) {
        await ctx.reply('❌ Invalid API credentials. Please check your API key and secret and try again with /link');
        ctx.userState.conversationState = undefined;
        this.conversationStates.delete(ctx.userState.userId);
        return;
      }

      // Encrypt and store credentials
      const encryptedKey = this.encryption.encrypt(apiKey);
      const encryptedSecret = this.encryption.encrypt(apiSecret);
      
      await this.db.storeApiCredentials(ctx.userState.userId, encryptedKey, encryptedSecret);
      
      // Update user state
      ctx.userState.isLinked = true;
      ctx.userState.conversationState = undefined;
      this.conversationStates.delete(ctx.userState.userId);
      
      // Store API client in session
      this.userSessions.set(ctx.userState.userId, testClient);
      await this.db.updateLastOkAt(ctx.userState.userId);

      await ctx.reply(`✅ **Credentials Linked Successfully!**\n\nYour API credentials have been encrypted and stored securely. You can now:\n\n• Execute trades with natural language\n• Monitor your positions\n• Check account balance\n• Set up risk management\n\n💡 Try: \`buy 0.1 ETH 5x\` or \`/positions\``);
    } catch (error) {
      console.error('API validation error:', error);
      ctx.userState.conversationState = undefined;
      this.conversationStates.delete(ctx.userState.userId);
      await ctx.reply('❌ Failed to validate credentials. Please ensure they\'re correct and try again with /link');
    }
  }

  private async handlePinInput(ctx: BotContext, pin: string): Promise<void> {
    // PIN handling implementation would go here
    // For now, clear the conversation state
    if (ctx.userState) {
      ctx.userState.conversationState = undefined;
      this.conversationStates.delete(ctx.userState.userId);
    }
    await ctx.reply('🔐 PIN functionality not yet implemented.');
  }

  private async handleUnlinkConfirmation(ctx: BotContext, response: string): Promise<void> {
    if (!ctx.userState?.conversationState) return;

    const confirmation = response.toLowerCase().trim();
    ctx.userState.conversationState = undefined;
    this.conversationStates.delete(ctx.userState.userId);

    if (confirmation === 'yes' || confirmation === 'y' || confirmation === 'confirm') {
      await this.performUnlink(ctx);
    } else {
      await ctx.reply('❌ Unlink cancelled.');
    }
  }

  private async handlePriceInput(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.userState?.conversationState) return;

    const price = parseFloat(text.replace(/[,$]/g, ''));
    if (isNaN(price) || price <= 0) {
      await ctx.reply('❌ Invalid price. Please enter a valid number (e.g., 45000 or 0.025):');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      this.clearConversationState(ctx);
      return;
    }

    const userId = ctx.userState?.userId || ctx.from!.id;
    const state = this.conversationStates.get(userId);
    if (!state || !state.symbol) {
      await ctx.reply('❌ Session expired. Please try again.');
      this.clearConversationState(ctx);
      return;
    }

    try {
      let result;
      if (state.type === 'expecting_stop_loss') {
        result = await apiClient.setStopLoss(state.symbol, price);
        await ctx.reply(`✅ Stop loss set for ${state.symbol} at $${price}\nOrder ID: ${result.orderId}`);
      } else if (state.type === 'expecting_take_profit') {
        result = await apiClient.setTakeProfit(state.symbol, price);
        await ctx.reply(`✅ Take profit set for ${state.symbol} at $${price}\nOrder ID: ${result.orderId}`);
      }
    } catch (error: any) {
      console.error('Price input error:', error);
      await ctx.reply(`❌ Failed to set ${state.type?.replace('expecting_', '').replace('_', ' ')}: ${error.message}`);
    }

    this.clearConversationState(ctx);
  }

  private async handleAmountInput(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.userState?.conversationState) return;

    const amount = parseFloat(text.replace(/[,$]/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount. Please enter a valid number (e.g., 100 or 50.5):');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      this.clearConversationState(ctx);
      return;
    }

    const userId = ctx.userState?.userId || ctx.from!.id;
    const state = this.conversationStates.get(userId);
    if (!state || !state.symbol || !state.marginType) {
      await ctx.reply('❌ Session expired. Please try again.');
      this.clearConversationState(ctx);
      return;
    }

    try {
      const marginType = state.marginType === 'add' ? 1 : 2;
      const result = await apiClient.modifyPositionMargin(state.symbol, amount, marginType);
      
      if (result.code === 200) {
        const action = state.marginType === 'add' ? 'Added' : 'Reduced';
        await ctx.reply(`✅ ${action} $${amount} margin for ${state.symbol}`);
      } else {
        await ctx.reply(`❌ Failed to modify margin: ${result.msg}`);
      }
    } catch (error: any) {
      console.error('Amount input error:', error);
      await ctx.reply(`❌ Failed to modify margin: ${error.message}`);
    }

    this.clearConversationState(ctx);
  }

  private clearConversationState(ctx: BotContext): void {
    if (ctx.userState) {
      ctx.userState.conversationState = undefined;
    }
    const userId = ctx.userState?.userId || ctx.from!.id;
    this.conversationStates.delete(userId);
  }

  private async handleCustomPairInput(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.userState?.conversationState?.data) return;

    const symbol = text.toUpperCase().replace(/\s/g, '');
    const tradingType = ctx.userState.conversationState.data.tradingType as 'spot' | 'perps';

    // Validate symbol format
    if (!/^[A-Z]+USDT$/.test(symbol)) {
      await ctx.reply('❌ Invalid symbol format. Please use format like BTCUSDT, ETHUSDT, etc.');
      return;
    }

    try {
      // Check if symbol exists by trying to get current price
      const currentPrice = await this.getCurrentPrice(symbol);
      if (currentPrice === 0) {
        await ctx.reply(`❌ Symbol ${symbol} not found or not available for trading.`);
        return;
      }

      // Clear conversation state
      this.clearConversationState(ctx);

      // Show trading interface for the custom symbol
      if (tradingType === 'spot') {
        await this.handleSpotTradingInterface(ctx, symbol);
      } else {
        await this.handlePerpsTradingInterface(ctx, symbol);
      }

    } catch (error) {
      console.error('Custom pair input error:', error);
      await ctx.reply(`❌ Error validating symbol ${symbol}. Please try again.`);
    }
  }

  private async handleCustomAmountInputText(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.userState?.conversationState?.data) return;

    const { tradingType, action, symbol } = ctx.userState.conversationState.data as { tradingType: 'spot' | 'perps', action: string, symbol: string };

    try {
      const parsedAmount = this.parseAmountString(text);
      if (!parsedAmount.success) {
        await ctx.reply(`❌ ${parsedAmount.error}\n\nPlease try formats like:\n• "$100" or "100u"\n• "0.1 ETH"\n• "50%" (of balance)${tradingType === 'perps' ? '\n• "200u 10x" (with leverage)' : ''}`);
        return;
      }

      // Clear conversation state
      this.clearConversationState(ctx);

      // Execute the trade based on parsed amount
      if (tradingType === 'spot') {
        await this.executeCustomSpotTrade(ctx, action, symbol, parsedAmount.result);
      } else {
        await this.executeCustomPerpsTrade(ctx, action, symbol, parsedAmount.result);
      }

    } catch (error) {
      console.error('Custom amount input error:', error);
      await ctx.reply(`❌ Error processing amount. Please try again.`);
    }
  }

  private parseAmountString(text: string): { success: boolean; result?: any; error?: string } {
    const cleanText = text.trim().toLowerCase();

    // Pattern 1: Dollar amount ($100, 100u, 100 usdt)
    const dollarMatch = cleanText.match(/^\$?(\d+(?:\.\d+)?)\s*(?:u|usdt)?$/);
    if (dollarMatch) {
      return {
        success: true,
        result: {
          type: 'usdt',
          amount: parseFloat(dollarMatch[1])
        }
      };
    }

    // Pattern 2: Percentage (50%, 25%)
    const percentMatch = cleanText.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (percentMatch) {
      return {
        success: true,
        result: {
          type: 'percentage',
          amount: parseFloat(percentMatch[1])
        }
      };
    }

    // Pattern 3: Base asset amount (0.1 btc, 1 eth)
    const assetMatch = cleanText.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
    if (assetMatch && assetMatch[2] !== 'usdt' && assetMatch[2] !== 'u') {
      return {
        success: true,
        result: {
          type: 'asset',
          amount: parseFloat(assetMatch[1]),
          asset: assetMatch[2].toUpperCase()
        }
      };
    }

    // Pattern 4: With leverage (200u 10x, $100 5x)
    const leverageMatch = cleanText.match(/^\$?(\d+(?:\.\d+)?)\s*(?:u|usdt)?\s*(\d+)x$/);
    if (leverageMatch) {
      return {
        success: true,
        result: {
          type: 'usdt_leverage',
          amount: parseFloat(leverageMatch[1]),
          leverage: parseInt(leverageMatch[2])
        }
      };
    }

    return {
      success: false,
      error: 'Unable to parse amount format'
    };
  }

  private async executeCustomSpotTrade(ctx: BotContext, action: string, symbol: string, amountData: any): Promise<void> {
    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found');
      return;
    }

    try {
      const side = action.toUpperCase() as 'BUY' | 'SELL';
      let orderParams: any = {
        symbol,
        side,
        type: 'MARKET'
      };

      if (amountData.type === 'usdt') {
        orderParams.quoteOrderQty = amountData.amount.toString();
      } else if (amountData.type === 'asset') {
        orderParams.quantity = amountData.amount.toString();
      } else if (amountData.type === 'percentage') {
        // Get balance and calculate percentage
        const balance = await apiClient.getSpotAccount();
        const usdtBalance = balance.balances.find((b: any) => b.asset === 'USDT');
        const availableAmount = parseFloat(usdtBalance?.free || '0');
        const percentAmount = (availableAmount * amountData.amount) / 100;
        orderParams.quoteOrderQty = percentAmount.toString();
      }

      const order = await apiClient.createSpotOrder(orderParams);

      await ctx.reply(
        `✅ **Custom Spot Order Executed**\n\n` +
        `📊 **Symbol:** ${symbol}\n` +
        `📈 **Side:** ${side}\n` +
        `💰 **Amount:** ${this.formatAmountData(amountData)}\n` +
        `🔢 **Order ID:** ${order.orderId}\n` +
        `⏰ **Time:** ${new Date().toLocaleTimeString()}`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('Custom spot trade error:', error);
      await ctx.reply(`❌ Failed to execute ${action} order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async executeCustomPerpsTrade(ctx: BotContext, action: string, symbol: string, amountData: any): Promise<void> {
    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found');
      return;
    }

    try {
      const side = action.toUpperCase() as 'BUY' | 'SELL';
      let leverage = amountData.leverage || ctx.userState?.settings.default_leverage || 10;
      
      // Set leverage if specified
      if (amountData.leverage) {
        await apiClient.changeLeverage(symbol, leverage);
      }

      let usdtAmount: number;
      if (amountData.type === 'usdt' || amountData.type === 'usdt_leverage') {
        usdtAmount = amountData.amount;
      } else if (amountData.type === 'percentage') {
        // Get futures balance
        const account = await apiClient.getAccountInfo();
        const availableBalance = parseFloat(account.availableBalance);
        usdtAmount = (availableBalance * amountData.amount) / 100;
      } else {
        throw new Error('Unsupported amount type for futures trading');
      }

      // Calculate quantity
      const currentPrice = await this.getCurrentPrice(symbol);
      const quantity = (usdtAmount / currentPrice).toString();

      const order = await apiClient.createOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity
      });

      await ctx.reply(
        `✅ **Custom Futures Order Executed**\n\n` +
        `📊 **Symbol:** ${symbol}\n` +
        `📈 **Side:** ${side}\n` +
        `💰 **Amount:** ${this.formatAmountData(amountData)}\n` +
        `⚡ **Leverage:** ${leverage}x\n` +
        `🔢 **Order ID:** ${order.orderId}\n` +
        `⏰ **Time:** ${new Date().toLocaleTimeString()}`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('Custom perps trade error:', error);
      await ctx.reply(`❌ Failed to execute ${action} order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private formatAmountData(amountData: any): string {
    switch (amountData.type) {
      case 'usdt':
      case 'usdt_leverage':
        return `$${amountData.amount}`;
      case 'asset':
        return `${amountData.amount} ${amountData.asset}`;
      case 'percentage':
        return `${amountData.amount}% of balance`;
      default:
        return `${amountData.amount}`;
    }
  }

  private getMainMenuKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📈 Trade', 'unified_trade'),
        Markup.button.callback('💰 Balance', 'balance')
      ],
      [
        Markup.button.callback('📊 Positions', 'positions'),
        Markup.button.callback('📈 P&L Analysis', 'pnl_analysis')
      ],
      [
        Markup.button.callback('🔗 Link API', 'link_api'),
        Markup.button.callback('⚙️ Settings', 'settings')
      ],
      [
        Markup.button.callback('📖 Help', 'help'),
        Markup.button.callback('🔄 Main Menu', 'main_menu')
      ]
    ]);
  }

  private async showMainMenu(ctx: BotContext): Promise<void> {
    const menuText = `
🏠 **Main Menu**

Choose from all available functions:

🔗 **Account**: ${ctx.userState?.isLinked ? '✅ API Linked' : '❌ API Not Linked'}
💰 **Quick Actions**: Trade, View Positions, Check Balance
📊 **Analysis**: P&L Reports, Market Data
⚙️ **Settings**: Configure Trading Preferences

Select an option below:
    `;

    try {
      await ctx.editMessageText(menuText, { 
        parse_mode: 'Markdown', 
        ...this.getMainMenuKeyboard() 
      });
    } catch (error) {
      // Fallback to new message if edit fails
      await ctx.reply(menuText, { 
        parse_mode: 'Markdown', 
        ...this.getMainMenuKeyboard() 
      });
    }
  }

  private async handleHelpCommand(ctx: BotContext): Promise<void> {
    const helpText = `
🤖 **Aster DEX Trading Bot - Complete Guide**

**🚀 Main Trading Interface:**
• \`/trade\` - **Unified trading hub** (choose spot or perps)
• \`/pnl\` - Comprehensive P&L analysis (spot + futures)
• \`/positions\` - View positions with quick trade buttons

**📈 Trading Flows:**
**Via /trade button interface:**
• 🏪 **Spot Trading** - Real asset ownership, no leverage
• ⚡ **Perps Trading** - Leveraged futures, long/short positions

**📝 Direct Commands (Alternative):**
• \`/buy BTCUSDT 100u x5 sl1% tp3%\` - Futures buy with leverage
• \`/sell ETHUSDT 0.25 x3 reduce\` - Futures sell/close
• \`/spot buy BTCUSDT 100u\` - Spot market buy
• \`/spot limit buy BTCUSDT 0.1 67000\` - Spot limit order

**💰 Account Management:**
• \`/balance\` - Account balance (futures + spot)
• \`/pnl\` - Real-time P&L with weighted averages

**⚙️ Settings & Setup:**
• \`/settings\` - Configure trading preferences  
• \`/link\` - Link API credentials securely
• \`/unlink\` - Remove API credentials

**📊 Market Data:**
• \`/price SYMBOL\` - Current price & 24h change

**💡 Getting Started:**
1. Use \`/link\` to connect your Aster DEX API keys
2. Use \`/trade\` to access the main trading interface
3. Choose between Spot or Perps trading modes
4. Start trading with guided button interfaces!

**Examples:**
${TradeParser.generateExamples().map(ex => `• \`${ex}\``).join('\n')}

**Size Notation:**
• \`100u\` = $100 quote value
• \`0.25\` = 0.25 base tokens

**Leverage & Risk:**
• \`x5\` = 5x leverage  
• \`sl1%\` = 1% stop loss
• \`tp3%\` = 3% take profit
• \`reduce\` = reduce-only order
      `;

    try {
      await ctx.editMessageText(helpText, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]
          ]
        }
      });
    } catch (error) {
      await ctx.reply(helpText, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('🔙 Back to Main Menu', 'main_menu')]
          ]
        }
      });
    }
  }

  private async setupBotCommands(): Promise<void> {
    try {
      const commands = [
        { command: 'start', description: '🚀 Start bot and show main menu' },
        { command: 'menu', description: '🏠 Show main menu with all functions' },
        { command: 'trade', description: '📈 Unified trading interface (spot/perps)' },
        { command: 'positions', description: '📊 View and manage open positions' },
        { command: 'balance', description: '💰 Check account balance' },
        { command: 'pnl', description: '📈 Comprehensive P&L analysis' },
        { command: 'link', description: '🔗 Link API credentials securely' },
        { command: 'settings', description: '⚙️ Configure trading preferences' },
        { command: 'help', description: '📖 Complete trading guide & commands' },
        { command: 'price', description: '💹 Get current price for symbol' }
      ];

      await this.bot.telegram.setMyCommands(commands);
      console.log('[Bot] Commands menu set up successfully');
      
    } catch (error) {
      console.error('[Bot] Failed to setup commands menu:', error);
    }
  }

  private getUserApiClient(ctx: BotContext): AsterApiClient | null {
    // Try to get the API client using the correct user ID
    if (ctx.userState?.userId) {
      return this.userSessions.get(ctx.userState.userId) || null;
    }
    
    // Fallback to ctx.from.id if userState is not available
    if (ctx.from?.id) {
      return this.userSessions.get(ctx.from.id) || null;
    }
    
    return null;
  }

  private async handleTradePreview(ctx: BotContext, command: TradeCommand): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      // Get API client to fetch order book
      const apiClient = await this.getOrCreateApiClient(ctx.userState.userId);
      
      // For now, create a simple mock order book - in production, fetch real data
      const mockOrderBook = {
        lastUpdateId: Date.now(),
        bids: [['45000', '1.0']],
        asks: [['45100', '1.0']]
      } as OrderBookDepth;

      // Generate trade preview
      const preview = await this.tradePreviewGenerator.generatePreview(
        command,
        mockOrderBook,
        ctx.userState.settings
      );

      if (!preview.success || !preview.preview) {
        const errorMsg = preview.errors.join('\n');
        await ctx.reply(`❌ **Trade Error**\n\n${errorMsg}`);
        return;
      }

      const trade = preview.preview;
      
      // Store pending trade
      this.pendingTrades.set(ctx.userState.userId, trade);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Trade', 'confirm_trade')],
        [Markup.button.callback('❌ Cancel', 'cancel_trade')]
      ]);

      const message = `
📈 **Trade Preview**

**Action:** ${trade.side} ${trade.symbol}
**Size:** ${trade.baseSize} ${trade.symbol.replace('USDT', '')} (~$${trade.quoteSize})
**Leverage:** ${trade.leverage}x
**Est. Price:** $${trade.estimatedPrice}
**Est. Fees:** $${trade.estimatedFees}
${trade.slippageWarning ? '\n⚠️ **High slippage warning**' : ''}
${trade.maxSlippageExceeded ? '\n❌ **Max slippage exceeded**' : ''}

⚠️ This action cannot be undone. Confirm to execute.
      `;

      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Trade preview error:', error);
      await ctx.reply('❌ Failed to generate trade preview. Please try again.');
    }
  }

  private async performUnlink(ctx: BotContext): Promise<void> {
    if (!ctx.userState) return;

    try {
      await this.db.removeApiCredentials(ctx.userState.userId);
      await this.db.removeSession(ctx.userState.userId);
      this.userSessions.delete(ctx.userState.userId);
      
      await ctx.reply('✅ API credentials have been unlinked successfully.');
    } catch (error) {
      console.error('Unlink error:', error);
      await ctx.reply('❌ Failed to unlink credentials. Please try again.');
    }
  }

  private async handleTradeCommand(ctx: BotContext, side: 'BUY' | 'SELL'): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const message = ctx.message;
    if (!('text' in message!)) return;

    const commandText = message.text;
    console.log('[DEBUG] Parsing command:', commandText);
    // For /buy and /sell commands, use the original text since TradeParser expects /buy or /sell prefix
    const parseResult = TradeParser.parseTradeCommand(commandText);
    console.log('[DEBUG] Parse result:', parseResult);
    
    if (!parseResult.success) {
      const errorText = [
        '❌ **Command Parse Error**',
        '',
        ...parseResult.errors.map(err => `• ${err}`),
        '',
        '💡 **Suggestions**:',
        ...parseResult.suggestions.map(suggestion => `• ${suggestion}`),
      ].join('\n');

      await ctx.reply(errorText, { parse_mode: 'Markdown' });
      return;
    }

    // Generate trade preview
    try {
      const apiClient = await this.getOrCreateApiClient(ctx.userState.userId);
      const orderBook = await apiClient.getOrderBook(parseResult.command!.symbol);
      
      const previewResult = await this.tradePreviewGenerator.generatePreview(
        parseResult.command!,
        orderBook,
        ctx.userState.settings
      );

      if (!previewResult.success) {
        const errorText = [
          '❌ **Preview Generation Failed**',
          '',
          ...previewResult.errors.map(err => `• ${err}`),
        ].join('\n');

        await ctx.reply(errorText, { parse_mode: 'Markdown' });
        return;
      }

      // Store pending trade
      this.pendingTrades.set(ctx.userState.userId, {
        preview: previewResult.preview,
        timestamp: Date.now(),
      });

      // Show preview with confirmation buttons
      const previewText = this.tradePreviewGenerator.formatPreviewForDisplay(previewResult.preview!);
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm', 'confirm_trade'),
          Markup.button.callback('❌ Cancel', 'cancel_trade'),
        ],
        [
          Markup.button.callback('✏️ Edit Size', 'edit_size'),
          Markup.button.callback('⚙️ Settings', 'settings'),
        ],
      ]);

      await ctx.reply(previewText, { parse_mode: 'Markdown', ...keyboard });

      // Add warnings if any
      if (previewResult.warnings.length > 0) {
        const warningText = [
          '⚠️ **Warnings**:',
          ...previewResult.warnings.map(warning => `• ${warning}`),
        ].join('\n');

        await ctx.reply(warningText, { parse_mode: 'Markdown' });
      }

    } catch (error) {
      console.error('Trade command error:', error);
      await ctx.reply('❌ Failed to process trade command. Please try again.');
    }
  }

  private async handleTradeConfirmation(ctx: BotContext): Promise<void> {
    if (!ctx.userState) return;

    const pendingTrade = this.pendingTrades.get(ctx.userState.userId);
    if (!pendingTrade) {
      await ctx.reply('❌ No pending trade found. Please create a new trade.');
      return;
    }

    try {
      const apiClient = await this.getOrCreateApiClient(ctx.userState.userId);
      const preview = pendingTrade.preview;
      
      // Set leverage before placing order
      console.log(`[DEBUG] Setting leverage for ${preview.symbol} to ${preview.leverage}x`);
      await apiClient.changeLeverage(preview.symbol, preview.leverage);
      
      // Execute the trade
      console.log(`[DEBUG] Placing order:`, {
        symbol: preview.symbol,
        side: preview.side,
        type: preview.command.orderType || 'MARKET',
        quantity: preview.baseSize
      });
      const orderResponse = await apiClient.createOrder({
        symbol: preview.symbol,
        side: preview.side,
        type: preview.command.orderType || 'MARKET',
        quantity: preview.baseSize,
        newOrderRespType: 'RESULT',
      });

      // Store order in database
      await this.db.storeOrder({
        user_id: ctx.userState.userId,
        client_order_id: orderResponse.clientOrderId,
        side: preview.side,
        symbol: preview.symbol,
        size: preview.baseSize,
        leverage: preview.leverage,
        status: orderResponse.status,
        tx: orderResponse.orderId.toString(),
      });

      const successText = [
        '✅ **Trade Executed Successfully!**',
        '',
        `📋 Order ID: \`${orderResponse.orderId}\``,
        `🔗 Client ID: \`${orderResponse.clientOrderId}\``,
        `📊 Status: ${orderResponse.status}`,
        `💰 Executed Qty: ${orderResponse.executedQty}`,
        `💵 Avg Price: $${orderResponse.avgPrice}`,
      ].join('\n');

      await ctx.editMessageText(successText, { parse_mode: 'Markdown' });

      // Clean up pending trade
      this.pendingTrades.delete(ctx.userState.userId);

    } catch (error) {
      console.error('Trade execution error:', error);
      await ctx.reply('❌ Failed to execute trade. Please check your account and try again.');
    }
  }

  private async handlePnLCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      return;
    }

    try {
      await ctx.reply('🔄 Calculating comprehensive P&L...');
      
      const pnlCalculator = new PnLCalculator(apiClient);
      const pnlResult = await pnlCalculator.calculateComprehensivePnL();
      
      if (!pnlResult.success) {
        await ctx.reply(pnlResult.message);
        return;
      }

      const formattedPnL = pnlCalculator.formatPnL(pnlResult);
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh', 'refresh_pnl'),
          Markup.button.callback('📊 Positions', 'positions')
        ],
        [
          Markup.button.callback('💰 Balance', 'balance'),
          Markup.button.callback('📈 Trade', 'unified_trade')
        ]
      ]);

      await ctx.reply(formattedPnL, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('P&L command error:', error);
      await ctx.reply('❌ Failed to calculate P&L. Please try again.');
    }
  }

  private async handlePositionsCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.getOrCreateApiClient(ctx.userState.userId);
      const positions = await apiClient.getPositionRisk();
      
      const openPositions = positions.filter(pos => parseFloat(pos.positionAmt) !== 0);
      
      if (openPositions.length === 0) {
        await ctx.reply('📊 No open positions found.');
        return;
      }

      let positionsText = '📊 **Open Positions**\n\n';
      
      openPositions.forEach(pos => {
        const side = parseFloat(pos.positionAmt) > 0 ? '🟢 LONG' : '🔴 SHORT';
        const pnl = parseFloat(pos.unrealizedPnl) || 0;
        const pnlEmoji = pnl >= 0 ? '📈' : '📉';
        
        positionsText += [
          `**${pos.symbol}** ${side}`,
          `• Size: ${Math.abs(parseFloat(pos.positionAmt))}`,
          `• Entry: $${pos.entryPrice}`,
          `• Leverage: ${pos.leverage}x`,
          `• ${pnlEmoji} PnL: $${pnl.toFixed(2)}`,
          '',
        ].join('\n');
      });

      // Enhanced positions with quick trading buttons
      const keyboard = Markup.inlineKeyboard([
        ...openPositions.map(pos => [
          Markup.button.callback(`📊 ${pos.symbol}`, `position_manage_${pos.symbol}`),
          Markup.button.callback(`⚡ Quick Trade`, `quick_trade_${pos.symbol}`)
        ]),
        [
          Markup.button.callback('🔄 Refresh', 'positions'),
          Markup.button.callback('📈 P&L Analysis', 'pnl_analysis')
        ]
      ]);

      await ctx.reply(positionsText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('Positions command error:', error);
      await ctx.reply('❌ Failed to fetch positions. Please try again.');
    }
  }

  private async handleBalanceCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.getOrCreateApiClient(ctx.userState.userId);
      const account = await apiClient.getAccountInfo();
      
      const balanceText = [
        '💰 **Account Balance**',
        '',
        `💵 Total Wallet Balance: $${parseFloat(account.totalWalletBalance).toFixed(2)}`,
        `📊 Total Margin Balance: $${parseFloat(account.totalMarginBalance).toFixed(2)}`,
        `✅ Available Balance: $${parseFloat(account.availableBalance).toFixed(2)}`,
        `📈 Unrealized PnL: $${parseFloat(account.totalUnrealizedPnl).toFixed(2)}`,
        '',
        `🏦 **Margin Info**`,
        `• Position Margin: $${parseFloat(account.totalPositionInitialMargin).toFixed(2)}`,
        `• Order Margin: $${parseFloat(account.totalOpenOrderInitialMargin).toFixed(2)}`,
      ].join('\n');

      await ctx.reply(balanceText, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error('Balance command error:', error);
      await ctx.reply('❌ Failed to fetch balance. Please try again.');
    }
  }

  private async handlePriceCommand(ctx: BotContext, symbol: string): Promise<void> {
    try {
      // Use a default API client for public data
      const apiClient = new AsterApiClient(this.config.aster.baseUrl, '', '');
      const ticker = await apiClient.get24hrTicker(symbol);
      
      const priceText = [
        `📈 **${symbol} Price Info**`,
        '',
        `💰 Last Price: $${ticker.lastPrice}`,
        `📊 24h Change: ${ticker.priceChangePercent}%`,
        `🔺 24h High: $${ticker.highPrice}`,
        `🔻 24h Low: $${ticker.lowPrice}`,
        `📦 24h Volume: ${ticker.volume}`,
      ].join('\n');

      await ctx.reply(priceText, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error('Price command error:', error);
      await ctx.reply(`❌ Failed to fetch price for ${symbol}. Please check the symbol.`);
    }
  }

  private async handlePanicCommand(ctx: BotContext): Promise<void> {
    await ctx.reply('🚨 **PANIC MODE ACTIVATED** - This will cancel all orders and close all positions for all users. Type CONFIRM to proceed.');
    
    // Implementation would handle admin confirmation and mass order cancellation
  }

  private async handleSettingsAction(ctx: BotContext, settingType: string): Promise<void> {
    // Implementation would handle various settings modifications
    await ctx.reply(`Settings action: ${settingType} (Implementation needed)`);
  }

  private async handlePositionAction(ctx: BotContext, action: string, symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      return;
    }

    try {
      switch (action) {
        case 'manage':
          await this.showPositionManagementMenu(ctx, symbol, apiClient);
          break;
        case 'close':
          await this.handleClosePosition(ctx, symbol, apiClient);
          break;
        case 'close_25':
          await this.handleClosePositionPercentage(ctx, symbol, apiClient, 25);
          break;
        case 'close_50':
          await this.handleClosePositionPercentage(ctx, symbol, apiClient, 50);
          break;
        case 'close_75':
          await this.handleClosePositionPercentage(ctx, symbol, apiClient, 75);
          break;
        case 'set_sl':
          await this.handleSetStopLoss(ctx, symbol, apiClient);
          break;
        case 'set_tp':
          await this.handleSetTakeProfit(ctx, symbol, apiClient);
          break;
        case 'add_margin':
          await this.handleAddMargin(ctx, symbol, apiClient);
          break;
        case 'reduce_margin':
          await this.handleReduceMargin(ctx, symbol, apiClient);
          break;
        default:
          await ctx.reply(`❌ Unknown position action: ${action}`);
      }
    } catch (error: any) {
      console.error(`Position action error for ${symbol}:`, error);
      await ctx.reply(`❌ Failed to ${action} position for ${symbol}: ${error.message}`);
    }
  }

  private async showPositionManagementMenu(ctx: BotContext, symbol: string, apiClient: AsterApiClient): Promise<void> {
    try {
      const positions = await apiClient.getPositionRisk();
      const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (!position) {
        await ctx.reply(`❌ No open position found for ${symbol}`);
        return;
      }

      const positionAmt = parseFloat(position.positionAmt);
      const side = positionAmt > 0 ? 'LONG' : 'SHORT';
      const pnl = parseFloat(position.unrealizedPnl) || 0;
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      
      const positionText = [
        `📊 **${symbol} Position Management**`,
        '',
        `**Side:** ${side}`,
        `**Size:** ${Math.abs(positionAmt)}`,
        `**Entry Price:** $${position.entryPrice}`,
        `**Leverage:** ${position.leverage}x`,
        `**${pnlEmoji} P&L:** $${pnl.toFixed(2)}`,
        '',
        'Choose an action:',
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔴 Close 25%', `position_close_25_${symbol}`),
          Markup.button.callback('🔴 Close 50%', `position_close_50_${symbol}`)
        ],
        [
          Markup.button.callback('🔴 Close 75%', `position_close_75_${symbol}`),
          Markup.button.callback('🔴 Close 100%', `position_close_${symbol}`)
        ],
        [
          Markup.button.callback('🛡️ Set Stop Loss', `position_set_sl_${symbol}`),
          Markup.button.callback('🎯 Set Take Profit', `position_set_tp_${symbol}`)
        ],
        [
          Markup.button.callback('➕ Add Margin', `position_add_margin_${symbol}`),
          Markup.button.callback('➖ Reduce Margin', `position_reduce_margin_${symbol}`)
        ],
        [
          Markup.button.callback('🔙 Back to Positions', 'positions')
        ]
      ]);

      await ctx.editMessageText(positionText, { parse_mode: 'Markdown', ...keyboard });
      
    } catch (error: any) {
      console.error('Position management menu error:', error);
      await ctx.reply(`❌ Failed to load position details for ${symbol}: ${error.message}`);
    }
  }

  private async handleClosePosition(ctx: BotContext, symbol: string, apiClient: AsterApiClient): Promise<void> {
    try {
      const result = await apiClient.closePosition(symbol, 100);
      await ctx.reply(`✅ Successfully closed position for ${symbol}\nOrder ID: ${result.orderId}`);
    } catch (error: any) {
      throw new Error(`Failed to close position: ${error.message}`);
    }
  }

  private async handleClosePositionPercentage(ctx: BotContext, symbol: string, apiClient: AsterApiClient, percentage: number): Promise<void> {
    try {
      const result = await apiClient.closePosition(symbol, percentage);
      await ctx.reply(`✅ Successfully closed ${percentage}% of ${symbol} position\nOrder ID: ${result.orderId}`);
    } catch (error: any) {
      throw new Error(`Failed to close ${percentage}% of position: ${error.message}`);
    }
  }

  private async handleSetStopLoss(ctx: BotContext, symbol: string, apiClient: AsterApiClient): Promise<void> {
    // Set conversation state to expect stop loss price input
    const userId = ctx.userState?.userId || ctx.from!.id;
    this.conversationStates.set(userId, {
      type: 'expecting_stop_loss',
      symbol,
      step: 'price'
    });
    
    await ctx.reply(`🛡️ Please enter the stop loss price for ${symbol}:\n(Enter price like: 45000 or 0.025)`);
  }

  private async handleSetTakeProfit(ctx: BotContext, symbol: string, apiClient: AsterApiClient): Promise<void> {
    // Set conversation state to expect take profit price input
    const userId = ctx.userState?.userId || ctx.from!.id;
    this.conversationStates.set(userId, {
      type: 'expecting_take_profit',
      symbol,
      step: 'price'
    });
    
    await ctx.reply(`🎯 Please enter the take profit price for ${symbol}:\n(Enter price like: 50000 or 0.030)`);
  }

  private async handleAddMargin(ctx: BotContext, symbol: string, apiClient: AsterApiClient): Promise<void> {
    // Set conversation state to expect margin amount input
    const userId = ctx.userState?.userId || ctx.from!.id;
    this.conversationStates.set(userId, {
      type: 'expecting_margin',
      symbol,
      step: 'amount',
      marginType: 'add'
    });
    
    await ctx.reply(`➕ Please enter the margin amount to add for ${symbol}:\n(Enter amount like: 100 or 50.5)`);
  }

  private async handleReduceMargin(ctx: BotContext, symbol: string, apiClient: AsterApiClient): Promise<void> {
    // Set conversation state to expect margin amount input
    const userId = ctx.userState?.userId || ctx.from!.id;
    this.conversationStates.set(userId, {
      type: 'expecting_margin',
      symbol,
      step: 'amount',
      marginType: 'reduce'
    });
    
    await ctx.reply(`➖ Please enter the margin amount to reduce for ${symbol}:\n(Enter amount like: 100 or 50.5)`);
  }

  private async showQuickTradingPanel(ctx: BotContext, symbol: string): Promise<void> {
    try {
      // Get current position info
      const apiClient = this.getUserApiClient(ctx);
      if (!apiClient) {
        await ctx.reply('❌ API session not found. Please try linking your credentials again.');
        return;
      }

      const positions = await apiClient.getPositionRisk();
      const position = positions.find(p => p.symbol === symbol);
      const currentPrice = await this.getCurrentPrice(symbol);
      
      let positionInfo = '';
      if (position && parseFloat(position.positionAmt) !== 0) {
        const side = parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT';
        const size = Math.abs(parseFloat(position.positionAmt));
        const pnl = parseFloat(position.unrealizedPnl) || 0;
        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
        
        positionInfo = [
          `**Current Position:** ${side} ${size} @ $${position.entryPrice}`,
          `${pnlEmoji} **P&L:** ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
          ''
        ].join('\n');
      }

      const quickTradeText = [
        `⚡ **Quick Trade: ${symbol}**`,
        `📈 **Current Price:** $${currentPrice.toFixed(4)}`,
        '',
        positionInfo,
        '🎯 **Quick Actions:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🟢 Buy 25u', `quick_buy_25u_${symbol}`),
          Markup.button.callback('🟢 Buy 50u', `quick_buy_50u_${symbol}`),
          Markup.button.callback('🟢 Buy 100u', `quick_buy_100u_${symbol}`)
        ],
        [
          Markup.button.callback('🔴 Sell 25%', `quick_sell_25p_${symbol}`),
          Markup.button.callback('🔴 Sell 50%', `quick_sell_50p_${symbol}`),
          Markup.button.callback('🔴 Sell 100%', `quick_sell_100p_${symbol}`)
        ],
        [
          Markup.button.callback('📊 Manage Position', `position_manage_${symbol}`),
          Markup.button.callback('📈 Advanced Trade', `unified_trade`)
        ],
        [
          Markup.button.callback('🔙 Back to Positions', 'positions')
        ]
      ]);

      await ctx.editMessageText(quickTradeText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('Quick trading panel error:', error);
      await ctx.reply(`❌ Failed to load trading panel for ${symbol}`);
    }
  }

  private async handleQuickTrade(ctx: BotContext, side: string, amount: number, unit: string, symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      return;
    }

    try {
      let orderParams: Partial<NewOrderRequest>;

      if (unit === 'u') {
        // Buy with USDT amount
        const currentPrice = await this.getCurrentPrice(symbol);
        const quantity = (amount / currentPrice).toString();
        
        orderParams = {
          symbol,
          side: side.toUpperCase() as 'BUY' | 'SELL',
          type: 'MARKET',
          quantity
        };
      } else if (unit === 'p' && side === 'sell') {
        // Sell percentage of position
        const positions = await apiClient.getPositionRisk();
        const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        
        if (!position) {
          await ctx.reply(`❌ No open position found for ${symbol}`);
          return;
        }

        const positionSize = Math.abs(parseFloat(position.positionAmt));
        const sellQuantity = (positionSize * amount / 100);
        
        orderParams = {
          symbol,
          side: parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY',
          type: 'MARKET',
          quantity: sellQuantity.toString(),
          reduceOnly: true
        };
      } else {
        await ctx.reply('❌ Invalid trade parameters');
        return;
      }

      // Execute the order
      await ctx.reply(`🔄 Executing ${side} order for ${symbol}...`);
      const result = await apiClient.createOrder(orderParams);
      
      const successMessage = [
        `✅ **Quick ${side.toUpperCase()} Executed**`,
        `**Symbol:** ${symbol}`,
        `**Order ID:** ${result.orderId}`,
        `**Quantity:** ${result.executedQty}`,
        result.avgPrice ? `**Avg Price:** $${result.avgPrice}` : '',
        result.cumQuote ? `**Total:** $${parseFloat(result.cumQuote).toFixed(2)}` : ''
      ].filter(Boolean).join('\n');

      await ctx.reply(successMessage, { parse_mode: 'Markdown' });

    } catch (error: any) {
      console.error('Quick trade error:', error);
      await ctx.reply(`❌ Quick ${side} failed for ${symbol}: ${error.message}`);
    }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    try {
      const apiClient = Array.from(this.userSessions.values())[0]; // Use any connected client for public data
      if (!apiClient) {
        throw new Error('No API client available');
      }
      
      const ticker = await apiClient.get24hrTicker(symbol);
      return parseFloat(ticker.lastPrice);
    } catch (error) {
      console.warn(`Failed to get current price for ${symbol}:`, error);
      return 0;
    }
  }

  private async handleSpotCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      return;
    }

    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const args = messageText.split(' ').slice(1); // Remove '/spot'
    
    if (args.length < 3) {
      await ctx.reply(`❌ Invalid spot command format.
      
**Usage:**
• \`/spot buy BTCUSDT 100u\` - Market buy with USDT
• \`/spot sell BTCUSDT 0.5\` - Market sell quantity
• \`/spot limit buy BTCUSDT 0.1 67000\` - Limit buy
• \`/spot limit sell BTCUSDT 0.1 68000\` - Limit sell`);
      return;
    }

    try {
      const [action, symbol, quantityOrAmount, price] = args;
      
      if (action === 'limit') {
        // Handle limit orders: /spot limit buy BTCUSDT 0.1 67000
        if (args.length < 5) {
          await ctx.reply('❌ Limit order requires: `/spot limit buy/sell SYMBOL QUANTITY PRICE`');
          return;
        }
        
        const [, side, sym, qty, limitPrice] = args;
        await this.executeSpotLimitOrder(ctx, apiClient, sym.toUpperCase(), side, qty, limitPrice);
      } else {
        // Handle market orders: /spot buy BTCUSDT 100u
        await this.executeSpotMarketOrder(ctx, apiClient, symbol.toUpperCase(), action, quantityOrAmount);
      }

    } catch (error: any) {
      console.error('Spot command error:', error);
      await ctx.reply(`❌ Spot trade failed: ${error.message}`);
    }
  }

  private async executeSpotMarketOrder(ctx: BotContext, apiClient: AsterApiClient, symbol: string, side: string, quantityOrAmount: string): Promise<void> {
    const isBuy = side.toLowerCase() === 'buy';
    const isQuoteOrder = quantityOrAmount.endsWith('u') || quantityOrAmount.includes('usdt');
    
    let orderParams: any = {
      symbol,
      side: isBuy ? 'BUY' : 'SELL',
      type: 'MARKET'
    };

    if (isQuoteOrder) {
      // Quote order (e.g., 100u = $100 worth)
      const amount = parseFloat(quantityOrAmount.replace(/[u$usdt]/gi, ''));
      orderParams.quoteOrderQty = amount.toString();
    } else {
      // Base quantity order (e.g., 0.5 = 0.5 BTC)
      orderParams.quantity = quantityOrAmount;
    }

    await ctx.reply(`🔄 Executing spot ${side} order for ${symbol}...`);
    
    const result = await apiClient.createSpotOrder(orderParams);
    
    const successMessage = [
      `✅ **Spot ${side.toUpperCase()} Executed**`,
      `**Symbol:** ${symbol}`,
      `**Order ID:** ${result.orderId}`,
      `**Status:** ${result.status}`,
      result.executedQty ? `**Executed Qty:** ${result.executedQty}` : '',
      result.cummulativeQuoteQty ? `**Total:** $${parseFloat(result.cummulativeQuoteQty).toFixed(2)}` : '',
      result.fills && result.fills.length > 0 ? `**Avg Price:** $${this.calculateAvgPrice(result.fills)}` : ''
    ].filter(Boolean).join('\n');

    await ctx.reply(successMessage, { parse_mode: 'Markdown' });
  }

  private async executeSpotLimitOrder(ctx: BotContext, apiClient: AsterApiClient, symbol: string, side: string, quantity: string, price: string): Promise<void> {
    const orderParams = {
      symbol,
      side: side.toUpperCase() as 'BUY' | 'SELL',
      type: 'LIMIT' as const,
      quantity,
      price,
      timeInForce: 'GTC' as const
    };

    await ctx.reply(`🔄 Placing spot limit ${side} order for ${symbol}...`);
    
    const result = await apiClient.createSpotOrder(orderParams);
    
    const successMessage = [
      `✅ **Spot Limit ${side.toUpperCase()} Placed**`,
      `**Symbol:** ${symbol}`,
      `**Order ID:** ${result.orderId}`,
      `**Quantity:** ${quantity}`,
      `**Limit Price:** $${price}`,
      `**Status:** ${result.status}`,
      `**Total Value:** $${(parseFloat(quantity) * parseFloat(price)).toFixed(2)}`
    ].join('\n');

    await ctx.reply(successMessage, { parse_mode: 'Markdown' });
  }

  private calculateAvgPrice(fills: any[]): string {
    if (!fills || fills.length === 0) return '0.0000';
    
    let totalQty = 0;
    let totalValue = 0;
    
    for (const fill of fills) {
      const qty = parseFloat(fill.qty);
      const price = parseFloat(fill.price);
      totalQty += qty;
      totalValue += qty * price;
    }
    
    return totalQty > 0 ? (totalValue / totalQty).toFixed(4) : '0.0000';
  }

  // === UNIFIED TRADE COMMAND ===
  
  private async handleUnifiedTradeCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const tradeText = [
      '📈 **Choose Trading Mode**',
      '',
      '**🏪 Spot Trading:**',
      '• Trade real assets (BTC, ETH, etc.)',
      '• No leverage, direct ownership',
      '• Perfect for long-term holding',
      '',
      '**⚡ Perps Trading:**',
      '• Leveraged perpetual futures',
      '• Up to 125x leverage available',
      '• Long and short positions',
      '',
      'Select your preferred trading mode:'
    ].join('\n');

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
      [
        Markup.button.callback('🏠 Main Menu', 'main_menu')
      ]
    ]);

    await ctx.reply(tradeText, { parse_mode: 'Markdown', ...keyboard });
  }

  private async handleSpotTradingInterface(ctx: BotContext, customSymbol?: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      return;
    }

    try {
      // Get spot account info
      const accountInfo = await apiClient.getSpotAccount();
      const usdtBalance = accountInfo.balances.find((b: any) => b.asset === 'USDT');
      const availableUsdt = usdtBalance ? parseFloat(usdtBalance.free) : 0;

      const spotText = [
        '🏪 **Spot Trading Interface**',
        '',
        `💰 **Available USDT:** $${availableUsdt.toFixed(2)}`,
        '',
        '**Popular Pairs:**',
        '• BTCUSDT - Bitcoin',
        '• ETHUSDT - Ethereum', 
        '• SOLUSDT - Solana',
        '',
        '**Quick Actions:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('₿ Buy BTC', 'spot_buy_BTCUSDT'),
          Markup.button.callback('⟠ Buy ETH', 'spot_buy_ETHUSDT')
        ],
        [
          Markup.button.callback('◎ Buy SOL', 'spot_buy_SOLUSDT'),
          Markup.button.callback('🪙 Buy ASTER', 'spot_buy_ASTERUSDT')
        ],
        [
          Markup.button.callback('🎯 Custom Pair', 'spot_custom_pair'),
          Markup.button.callback('💱 Sell Assets', 'spot_sell_menu')
        ],
        [
          Markup.button.callback('📋 Spot Orders', 'spot_orders'),
          Markup.button.callback('💰 Balance', 'balance')
        ],
        [
          Markup.button.callback('🔙 Back to Trade Menu', 'unified_trade'),
          Markup.button.callback('🏠 Main Menu', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(spotText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('Spot trading interface error:', error);
      await ctx.reply('❌ Failed to load spot trading interface. Please try again.');
    }
  }

  private async handlePerpsTradingInterface(ctx: BotContext, customSymbol?: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.reply('❌ API session not found. Please try linking your credentials again.');
      return;
    }

    try {
      // Get futures account info
      const accountInfo = await apiClient.getAccountInfo();
      const availableBalance = parseFloat(accountInfo.availableBalance || '0');
      const totalWallet = parseFloat(accountInfo.totalWalletBalance || '0');

      const perpsText = [
        '⚡ **Perps Trading Interface**',
        '',
        `💰 **Available Balance:** $${availableBalance.toFixed(2)}`,
        `📊 **Total Wallet:** $${totalWallet.toFixed(2)}`,
        '',
        '**Popular Perps:**',
        '• BTCUSDT - Bitcoin Perpetual',
        '• ETHUSDT - Ethereum Perpetual',
        '• SOLUSDT - Solana Perpetual',
        '',
        '**Quick Actions:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
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
        [
          Markup.button.callback('🎯 Custom Pair', 'perps_custom_pair'),
          Markup.button.callback('📊 Open Positions', 'positions')
        ],
        [
          Markup.button.callback('⚙️ Leverage Settings', 'leverage_settings'),
          Markup.button.callback('💰 Balance', 'balance')
        ],
        [
          Markup.button.callback('🔙 Back to Trade Menu', 'unified_trade'),
          Markup.button.callback('🏠 Main Menu', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(perpsText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('Perps trading interface error:', error);
      await ctx.reply('❌ Failed to load perps trading interface. Please try again.');
    }
  }

  private async handleSpotTradeAction(ctx: BotContext, action: string, symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const actionText = action === 'buy' ? 'Buy' : 'Sell';
    const emoji = action === 'buy' ? '🟢' : '🔴';
    
    // Get current price for reference
    const currentPrice = await this.getCurrentPrice(symbol);
    
    const formText = [
      `${emoji} **Spot ${actionText}: ${symbol}**`,
      `📈 **Current Price:** $${currentPrice.toFixed(4)}`,
      '',
      '💰 **Choose Order Size:**',
      'Select a preset amount or enter custom:'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('$25', `spot_execute_${action}_${symbol}_25u`),
        Markup.button.callback('$50', `spot_execute_${action}_${symbol}_50u`),
        Markup.button.callback('$100', `spot_execute_${action}_${symbol}_100u`)
      ],
      [
        Markup.button.callback('$250', `spot_execute_${action}_${symbol}_250u`),
        Markup.button.callback('$500', `spot_execute_${action}_${symbol}_500u`),
        Markup.button.callback('$1000', `spot_execute_${action}_${symbol}_1000u`)
      ],
      [
        Markup.button.callback('🎯 Custom Amount', `spot_custom_amount_${action}_${symbol}`),
        Markup.button.callback('📋 Limit Order', `spot_limit_${action}_${symbol}`)
      ],
      [
        Markup.button.callback('🔙 Back to Spot', 'trade_spot')
      ]
    ]);

    await ctx.editMessageText(formText, { parse_mode: 'Markdown', ...keyboard });
  }

  private async handlePerpsTradeAction(ctx: BotContext, action: string, symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const actionText = action === 'buy' ? 'Long' : 'Short';
    const emoji = action === 'buy' ? '📈' : '📉';
    
    // Get current price for reference
    const currentPrice = await this.getCurrentPrice(symbol);
    
    const formText = [
      `${emoji} **${actionText} Position: ${symbol}**`,
      `📈 **Current Price:** $${currentPrice.toFixed(4)}`,
      '',
      '💰 **Choose Position Size:**',
      'Select preset amount and leverage:'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('$25 × 5x', `perps_execute_${action}_${symbol}_25u_5x`),
        Markup.button.callback('$50 × 5x', `perps_execute_${action}_${symbol}_50u_5x`),
        Markup.button.callback('$100 × 5x', `perps_execute_${action}_${symbol}_100u_5x`)
      ],
      [
        Markup.button.callback('$25 × 10x', `perps_execute_${action}_${symbol}_25u_10x`),
        Markup.button.callback('$50 × 10x', `perps_execute_${action}_${symbol}_50u_10x`),
        Markup.button.callback('$100 × 10x', `perps_execute_${action}_${symbol}_100u_10x`)
      ],
      [
        Markup.button.callback('$250 × 5x', `perps_execute_${action}_${symbol}_250u_5x`),
        Markup.button.callback('$500 × 10x', `perps_execute_${action}_${symbol}_500u_10x`)
      ],
      [
        Markup.button.callback('🎯 Custom Size', `perps_custom_amount_${action}_${symbol}`),
        Markup.button.callback('⚙️ Advanced', `perps_advanced_${action}_${symbol}`)
      ],
      [
        Markup.button.callback('🔙 Back to Perps', 'trade_perps')
      ]
    ]);

    await ctx.editMessageText(formText, { parse_mode: 'Markdown', ...keyboard });
  }

  // === BUTTON-BASED TRADING INTERFACE ===
  
  private async handleTradeInterface(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🟢 BUY', 'trade_buy'),
        Markup.button.callback('🔴 SELL', 'trade_sell')
      ],
      [
        Markup.button.callback('📊 Positions', 'positions'),
        Markup.button.callback('💰 Balance', 'balance')
      ],
      [
        Markup.button.callback('⚙️ Settings', 'settings')
      ]
    ]);

    const message = `
🎯 **Trading Interface**

Choose an action to get started:

• **Buy** - Open long positions
• **Sell** - Open short positions or close longs
• **Positions** - View your open positions
• **Balance** - Check your account balance
    `;

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  private async handleSymbolSelection(ctx: BotContext, side: 'BUY' | 'SELL'): Promise<void> {
    const popularSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT'];
    
    const keyboard = Markup.inlineKeyboard([
      ...popularSymbols.map(symbol => [
        Markup.button.callback(`${symbol.replace('USDT', '')}`, `symbol_${side}_${symbol}`)
      ]),
      [Markup.button.callback('🔙 Back', 'trade_back')]
    ]);

    const actionText = side === 'BUY' ? '🟢 Buy' : '🔴 Sell';
    const message = `${actionText} - Select Symbol\n\nChoose the cryptocurrency you want to trade:`;

    await ctx.editMessageText(message, { ...keyboard });
  }

  private async handleQuantitySelection(ctx: BotContext, side: 'BUY' | 'SELL', symbol: string): Promise<void> {
    const presetQuantities = ['0.01', '0.1', '0.25', '0.5', '1.0'];
    
    const keyboard = Markup.inlineKeyboard([
      ...presetQuantities.map(qty => [
        Markup.button.callback(`${qty} ${symbol.replace('USDT', '')}`, `qty_${side}_${symbol}_${qty}`)
      ]),
      [Markup.button.callback('🔙 Back', 'trade_back')]
    ]);

    const actionText = side === 'BUY' ? '🟢 Buy' : '🔴 Sell';
    const message = `${actionText} ${symbol.replace('USDT', '')} - Select Quantity\n\nChoose the amount you want to trade:`;

    await ctx.editMessageText(message, { ...keyboard });
  }

  private async handleLeverageSelection(ctx: BotContext, side: 'BUY' | 'SELL', symbol: string, quantity: string): Promise<void> {
    const leverageOptions = ['2', '5', '10', '20'];
    
    const keyboard = Markup.inlineKeyboard([
      leverageOptions.map(lev => 
        Markup.button.callback(`${lev}x`, `lev_${side}_${symbol}_${quantity}_${lev}`)
      ),
      [Markup.button.callback('🔙 Back', 'trade_back')]
    ]);

    const actionText = side === 'BUY' ? '🟢 Buy' : '🔴 Sell';
    const message = `${actionText} ${quantity} ${symbol.replace('USDT', '')} - Select Leverage\n\nChoose your leverage:`;

    await ctx.editMessageText(message, { ...keyboard });
  }

  private async handleButtonTradeConfirmation(ctx: BotContext, side: 'BUY' | 'SELL', symbol: string, quantity: string, leverage: string): Promise<void> {
    if (!ctx.userState) return;

    try {
      // Create trade command object
      const tradeCommand: TradeCommand = {
        action: side,
        symbol: symbol,
        size: quantity,
        sizeType: 'BASE',
        leverage: parseInt(leverage),
        orderType: 'MARKET',
        reduceOnly: false
      };

      // Generate preview using existing logic
      const apiClient = await this.getOrCreateApiClient(ctx.userState.userId);
      const orderBook = await apiClient.getOrderBook(symbol);
      
      const previewResult = await this.tradePreviewGenerator.generatePreview(
        tradeCommand,
        orderBook,
        ctx.userState.settings
      );

      if (!previewResult.success || !previewResult.preview) {
        const errorMsg = previewResult.errors.join('\n');
        await ctx.editMessageText(`❌ **Preview Error**\n\n${errorMsg}`);
        return;
      }

      const preview = previewResult.preview;
      
      // Store pending trade
      this.pendingTrades.set(ctx.userState.userId, { preview, timestamp: Date.now() });

      const actionText = side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Trade', 'confirm_trade'),
          Markup.button.callback('❌ Cancel', 'trade_back')
        ]
      ]);

      const message = `
🎯 **Trade Confirmation**

**Action:** ${actionText} ${preview.symbol.replace('USDT', '')}
**Size:** ${preview.baseSize} ${preview.symbol.replace('USDT', '')} (~$${preview.quoteSize})
**Leverage:** ${preview.leverage}x
**Est. Price:** $${preview.estimatedPrice}
**Est. Fees:** $${preview.estimatedFees}
${preview.slippageWarning ? '\n⚠️ **High slippage warning**' : ''}
${preview.maxSlippageExceeded ? '\n❌ **Max slippage exceeded**' : ''}

⚠️ **This action cannot be undone. Confirm to execute.**
      `;

      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      
    } catch (error) {
      console.error('Button trade confirmation error:', error);
      await ctx.editMessageText('❌ Failed to generate trade preview. Please try again.');
    }
  }

  private async handleCustomPairSelection(ctx: BotContext, tradingType: 'spot' | 'perps'): Promise<void> {
    if (!ctx.userState) return;

    try {
      await ctx.editMessageText(
        '🎯 **Custom Trading Pair**\n\n' +
        '✍️ Please type the trading pair symbol you want to trade:\n\n' +
        '📝 Examples:\n' +
        '• BTCUSDT\n' +
        '• ETHUSDT\n' +
        '• SOLUSDT\n' +
        '• ADAUSDT\n\n' +
        '💡 Just type the symbol and I\'ll show you trading options!',
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback('🔙 Back', `trade_${tradingType}`)],
            ]
          }
        }
      );

      // Set conversation state to expect custom pair input
      const updatedState = { 
        step: 'waiting_custom_pair' as any,
        data: { tradingType }
      };
      
      ctx.userState.conversationState = updatedState;
      this.conversationStates.set(ctx.userState.userId, updatedState);

    } catch (error) {
      console.error('Custom pair selection error:', error);
      await ctx.reply('❌ Failed to set up custom pair selection.');
    }
  }

  private async handleCustomAmountInput(ctx: BotContext, tradingType: 'spot' | 'perps', action: string, symbol: string): Promise<void> {
    if (!ctx.userState) return;

    try {
      const actionText = action.toUpperCase() === 'BUY' ? '🟢 Buy' : '🔴 Sell';
      
      await ctx.editMessageText(
        `💰 **Custom ${actionText} Amount for ${symbol}**\n\n` +
        '✍️ Please specify your trade amount:\n\n' +
        '📝 Examples:\n' +
        '• "$100" (trade with 100 USDT)\n' +
        '• "0.1 BTC" (trade 0.1 BTC)\n' +
        '• "50%" (use 50% of balance)\n' +
        (tradingType === 'perps' ? '• "200u 10x" (200 USDT with 10x leverage)\n' : '') +
        '\n💡 Just type your desired amount naturally!',
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback('🔙 Back', `trade_${tradingType}`)],
            ]
          }
        }
      );

      // Set conversation state to expect custom amount input
      const updatedState = { 
        step: 'waiting_custom_amount' as any,
        data: { tradingType, action, symbol }
      };
      
      ctx.userState.conversationState = updatedState;
      this.conversationStates.set(ctx.userState.userId, updatedState);

    } catch (error) {
      console.error('Custom amount input error:', error);
      await ctx.reply('❌ Failed to set up custom amount input.');
    }
  }

  private async executeSpotPresetOrder(ctx: BotContext, action: string, symbol: string, amount: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.answerCbQuery('❌ Please link your API credentials first');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.answerCbQuery('❌ API session not found');
      return;
    }

    try {
      const side = action.toUpperCase() as 'BUY' | 'SELL';
      const usdtAmount = parseInt(amount);
      
      // Get current price for quantity calculation
      const currentPrice = await this.getCurrentPrice(symbol);
      const quantity = (usdtAmount / currentPrice).toString();

      const order = await apiClient.createSpotOrder({
        symbol,
        side,
        type: 'MARKET',
        quoteOrderQty: usdtAmount.toString()
      });

      await ctx.answerCbQuery('✅ Spot order executed!');
      await ctx.editMessageText(
        `✅ **Spot Order Executed**\n\n` +
        `📊 **Symbol:** ${symbol}\n` +
        `📈 **Side:** ${side}\n` +
        `💰 **Amount:** $${usdtAmount}\n` +
        `🔢 **Order ID:** ${order.orderId}\n` +
        `⏰ **Time:** ${new Date().toLocaleTimeString()}`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('Spot preset order error:', error);
      await ctx.answerCbQuery('❌ Order failed');
      await ctx.reply(`❌ Failed to execute ${action} order for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async executePerpsPresetOrder(ctx: BotContext, action: string, symbol: string, amount: string, leverage: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.answerCbQuery('❌ Please link your API credentials first');
      return;
    }

    const apiClient = this.getUserApiClient(ctx);
    if (!apiClient) {
      await ctx.answerCbQuery('❌ API session not found');
      return;
    }

    try {
      const side = action.toUpperCase() as 'BUY' | 'SELL';
      const usdtAmount = parseInt(amount);
      const leverageValue = parseInt(leverage);
      
      // Set leverage first
      await apiClient.changeLeverage(symbol, leverageValue);
      
      // Get current price for quantity calculation
      const currentPrice = await this.getCurrentPrice(symbol);
      const quantity = (usdtAmount / currentPrice).toString();

      const order = await apiClient.createOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity
      });

      await ctx.answerCbQuery('✅ Futures order executed!');
      await ctx.editMessageText(
        `✅ **Futures Order Executed**\n\n` +
        `📊 **Symbol:** ${symbol}\n` +
        `📈 **Side:** ${side}\n` +
        `💰 **Amount:** $${usdtAmount}\n` +
        `⚡ **Leverage:** ${leverageValue}x\n` +
        `🔢 **Order ID:** ${order.orderId}\n` +
        `⏰ **Time:** ${new Date().toLocaleTimeString()}`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('Perps preset order error:', error);
      await ctx.answerCbQuery('❌ Order failed');
      await ctx.reply(`❌ Failed to execute ${action} order for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getOrCreateApiClient(userId: number): Promise<AsterApiClient> {
    let client = this.userSessions.get(userId);
    
    if (!client) {
      const credentials = await this.db.getApiCredentials(userId);
      if (!credentials) {
        throw new Error('No API credentials found');
      }

      const apiKey = this.encryption.decrypt(credentials.aster_key_enc);
      const apiSecret = this.encryption.decrypt(credentials.aster_secret_enc);

      client = new AsterApiClient(this.config.aster.baseUrl, apiKey, apiSecret);
      
      // Test the credentials
      const isValid = await client.validateApiCredentials();
      if (!isValid) {
        throw new Error('Invalid API credentials');
      }

      await this.db.updateLastOkAt(userId);
      this.userSessions.set(userId, client);
    }

    return client;
  }

  async start(): Promise<void> {
    try {
      // Initialize database
      await this.db.connect();
      await this.db.initializeSchema();

      // Test encryption
      if (!EncryptionManager.test(this.config.encryption.key)) {
        throw new Error('Encryption test failed');
      }

      // Initialize exchange info for filters
      await this.initializeExchangeInfo();

      // Start notification manager
      await this.notificationManager.start(this.bot);

      // Setup bot commands menu
      await this.setupBotCommands();

      // Start bot
      await this.bot.launch();
      console.log('[Bot] Started successfully');

      // Graceful shutdown
      process.once('SIGINT', () => this.stop('SIGINT'));
      process.once('SIGTERM', () => this.stop('SIGTERM'));

    } catch (error) {
      console.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  private async stop(signal: string): Promise<void> {
    console.log(`[Bot] Received ${signal}, shutting down gracefully...`);
    
    try {
      this.bot.stop(signal);
      await this.notificationManager.stop();
      await this.db.disconnect();
      
      console.log('[Bot] Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

// Start the bot
const bot = new AsterTradingBot();
bot.start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export default AsterTradingBot;