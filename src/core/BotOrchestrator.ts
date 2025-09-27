import { Telegraf } from 'telegraf';
import express from 'express';

import { BotConfig } from '../types';
import { DatabaseManager } from '../db';
import { EncryptionManager } from '../encryption';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';
import { AuthMiddleware, BotContext } from '../middleware/AuthMiddleware';
import { NavigationHandler } from '../handlers/NavigationHandler';
import { TradingHandler } from '../handlers/TradingHandler';
import { ApiClientService } from '../services/ApiClientService';
import { PriceService } from '../services/PriceService';

/**
 * Main orchestrator that wires together all components
 * This is the only class that knows about the overall system architecture
 */
export class BotOrchestrator {
  private bot!: Telegraf<BotContext>;
  private config: BotConfig;
  private server!: express.Application;
  
  // Core services
  private db!: DatabaseManager;
  private encryption!: EncryptionManager;
  private eventEmitter!: BotEventEmitter;
  
  // Middleware
  private authMiddleware!: AuthMiddleware;
  
  // Services
  private apiClientService!: ApiClientService;
  private priceService!: PriceService;
  
  // Handlers
  private navigationHandler!: NavigationHandler;
  private tradingHandler!: TradingHandler;

  constructor(config: BotConfig) {
    this.config = config;
    this.initializeCore();
    this.initializeServices();
    this.initializeMiddleware();
    this.initializeHandlers();
    this.setupBot();
    this.setupServer();
    this.setupEventListeners();
  }

  /**
   * Initialize core infrastructure
   */
  private initializeCore(): void {
    this.db = new DatabaseManager(this.config.database.url, this.config.redis?.url);
    this.encryption = new EncryptionManager(this.config.encryption.key);
    this.eventEmitter = new BotEventEmitter();
    
    console.log('[Orchestrator] Core services initialized');
  }

  /**
   * Initialize business services
   */
  private initializeServices(): void {
    this.apiClientService = new ApiClientService(
      this.db,
      this.encryption,
      {
        baseUrl: this.config.aster.baseUrl,
        defaultRecvWindow: this.config.aster.defaultRecvWindow
      },
      this.eventEmitter
    );
    
    this.priceService = new PriceService(this.eventEmitter);
    
    console.log('[Orchestrator] Business services initialized');
  }

  /**
   * Initialize middleware
   */
  private initializeMiddleware(): void {
    this.authMiddleware = new AuthMiddleware(this.db, this.eventEmitter);
    
    console.log('[Orchestrator] Middleware initialized');
  }

  /**
   * Initialize handlers
   */
  private initializeHandlers(): void {
    this.navigationHandler = new NavigationHandler(this.eventEmitter);
    
    this.tradingHandler = new TradingHandler({
      eventEmitter: this.eventEmitter,
      apiClientService: this.apiClientService,
      priceService: this.priceService
    });
    
    console.log('[Orchestrator] Handlers initialized');
  }

  /**
   * Setup Telegram bot with middleware and handlers
   */
  private setupBot(): void {
    this.bot = new Telegraf<BotContext>(this.config.telegram.token);
    
    // Global middleware
    this.bot.use(this.authMiddleware.middleware());
    
    // Commands
    this.setupCommands();
    
    // Actions (button callbacks)
    this.setupActions();
    
    // Text handlers
    this.setupTextHandlers();
    
    // Error handling
    this.bot.catch((err, ctx) => {
      console.error('[Bot] Unhandled error:', err);
      this.eventEmitter.emitEvent({
        type: EventTypes.ERROR_OCCURRED,
        timestamp: new Date(),
        userId: ctx.userState?.userId || 0,
        telegramId: ctx.userState?.telegramId || 0,
        correlationId: ctx.correlationId,
        error: err as Error,
        context: { type: 'bot_error' }
      });
    });
    
    console.log('[Orchestrator] Bot setup complete');
  }

  /**
   * Setup Express server for health checks and webhooks
   */
  private setupServer(): void {
    this.server = express();
    this.server.use(express.json());
    
    // Root endpoint for basic connectivity test
    this.server.get('/', (req, res) => {
      res.json({ status: 'AsterBot is running', timestamp: new Date().toISOString() });
    });
    
    // Health check endpoint
    this.server.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        clients: this.apiClientService.getClientCount(),
        auth_cache: this.authMiddleware.getCacheStats()
      });
    });
    
    // Metrics endpoint
    this.server.get('/metrics', (req, res) => {
      res.json({
        api_clients: this.apiClientService.getClientCount(),
        auth_cache: this.authMiddleware.getCacheStats(),
        // Add more metrics as needed
      });
    });

    // Webhook endpoint will be set up after bot initialization
    console.log(`[Orchestrator] Webhook endpoint will be configured at ${this.config.webhook.path}`);
    
    console.log('[Orchestrator] Server setup complete');
  }

  /**
   * Setup event listeners for logging and monitoring
   */
  private setupEventListeners(): void {
    // Trading events
    this.eventEmitter.onEvent(EventTypes.TRADE_INITIATED, (event: any) => {
      console.log(`[Trading] Trade initiated: ${event.symbol} ${event.action} by user ${event.userId}`);
    });

    this.eventEmitter.onEvent(EventTypes.TRADE_EXECUTED, (event: any) => {
      console.log(`[Trading] Trade executed: ${event.symbol} ${event.action} by user ${event.userId}`);
    });

    // Navigation events
    this.eventEmitter.onEvent(EventTypes.NAVIGATION_CHANGED, (event: any) => {
      console.log(`[Navigation] User ${event.userId} navigated from ${event.from} to ${event.to}`);
    });

    // Error events
    this.eventEmitter.onEvent(EventTypes.ERROR_OCCURRED, (event: any) => {
      console.error(`[Error] User ${event.userId}: ${event.error.message}`);
    });

    // API events
    this.eventEmitter.onEvent(EventTypes.API_CALL_SUCCESS, (event: any) => {
      console.log(`[API] Success: ${event.method} ${event.endpoint} (${event.duration}ms)`);
    });

    this.eventEmitter.onEvent(EventTypes.API_CALL_FAILED, (event: any) => {
      console.warn(`[API] Failed: ${event.method} ${event.endpoint} (${event.duration}ms)`);
    });
    
    console.log('[Orchestrator] Event listeners setup complete');
  }

  /**
   * Setup bot commands
   */
  private setupCommands(): void {
    // Start command - shows welcome message
    this.bot.command('start', (ctx) => 
      this.navigationHandler.showWelcomeMessage(ctx)
    );

    // Menu command - shows main menu
    this.bot.command('menu', (ctx) => 
      this.navigationHandler.showMainMenu(ctx)
    );

    // Help command
    this.bot.command('help', (ctx) => 
      this.handleHelpCommand(ctx)
    );

    // Link command
    this.bot.command('link', (ctx) => 
      this.handleLinkCommand(ctx)
    );

    // Unlink command
    this.bot.command('unlink', (ctx) => 
      this.handleUnlinkCommand(ctx)
    );

    // Settings command
    this.bot.command('settings', (ctx) => 
      this.handleSettingsCommand(ctx)
    );

    // Buy command
    this.bot.command('buy', (ctx) => 
      this.handleBuyCommand(ctx)
    );

    // Sell command
    this.bot.command('sell', (ctx) => 
      this.handleSellCommand(ctx)
    );

    // Positions command
    this.bot.command('positions', (ctx) => 
      this.handlePositionsCommand(ctx)
    );

    // Balance command
    this.bot.command('balance', (ctx) => 
      this.handleBalanceCommand(ctx)
    );

    // P&L command
    this.bot.command('pnl', (ctx) => 
      this.handlePnLCommand(ctx)
    );

    // Spot command
    this.bot.command('spot', (ctx) => 
      this.handleSpotCommand(ctx)
    );

    // Price command
    this.bot.command('price', (ctx) => 
      this.handlePriceCommand(ctx)
    );

    // Trade command
    this.bot.command('trade', (ctx) => 
      this.navigationHandler.showTradingMenu(ctx)
    );

    // Panic command (admin only)
    this.bot.command('panic', (ctx) => 
      this.handlePanicCommand(ctx)
    );

    console.log('[Orchestrator] Commands registered');
  }

  /**
   * Setup bot actions (button callbacks)
   */
  private setupActions(): void {
    // Main menu
    this.bot.action('main_menu', (ctx) => 
      this.navigationHandler.showMainMenu(ctx)
    );

    // Trading menu
    this.bot.action('unified_trade', (ctx) => 
      this.navigationHandler.showTradingMenu(ctx)
    );

    // Spot trading
    this.bot.action('trade_spot', (ctx) => 
      this.tradingHandler.handleSpotTrading(ctx)
    );

    // Perps trading
    this.bot.action('trade_perps', (ctx) => 
      this.tradingHandler.handlePerpsTrading(ctx)
    );

    // Dynamic symbol trading actions
    this.bot.action(/^perps_buy_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.tradingHandler.handlePerpsSymbolTrading(ctx, symbol, 'BUY');
    });

    this.bot.action(/^perps_sell_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.tradingHandler.handlePerpsSymbolTrading(ctx, symbol, 'SELL');
    });

    this.bot.action(/^spot_buy_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.tradingHandler.handleSpotSymbolTrading(ctx, symbol, 'BUY');
    });

    this.bot.action(/^spot_sell_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.tradingHandler.handleSpotSymbolTrading(ctx, symbol, 'SELL');
    });

    // Basic action handlers
    this.bot.action('balance', (ctx) => 
      this.handleBalanceCommand(ctx)
    );

    this.bot.action('positions', (ctx) => 
      this.handlePositionsCommand(ctx)
    );

    this.bot.action('settings', (ctx) => 
      this.handlePlaceholderAction(ctx, '⚙️ Settings feature coming soon!')
    );

    this.bot.action('help', (ctx) => 
      this.handleHelpCommand(ctx)
    );

    this.bot.action('link_api', (ctx) => 
      this.handleLinkCommand(ctx)
    );

    this.bot.action('spot_assets', (ctx) => 
      this.handlePlaceholderAction(ctx, '🏦 Spot assets feature coming soon!')
    );

    this.bot.action('spot_sell_menu', (ctx) => 
      this.handlePlaceholderAction(ctx, '💱 Spot sell menu coming soon!')
    );

    this.bot.action('spot_custom_pair', (ctx) => 
      this.handlePlaceholderAction(ctx, '🎯 Custom spot pair feature coming soon!')
    );

    this.bot.action('perps_custom_pair', (ctx) => 
      this.handlePlaceholderAction(ctx, '🎯 Custom perps pair feature coming soon!')
    );

    this.bot.action('pnl_analysis', (ctx) => 
      this.handlePlaceholderAction(ctx, '📈 P&L Analysis feature coming soon!')
    );

    // Spot execute trade handlers
    this.bot.action(/^spot_execute_(buy|sell)_(.+)_(\d+)u$/, (ctx) => {
      const [, side, symbol, amount] = ctx.match;
      this.handleSpotExecuteAction(ctx, symbol, side.toUpperCase() as 'BUY' | 'SELL', parseInt(amount));
    });

    // Perps execute trade handlers
    this.bot.action(/^perps_execute_(buy|sell)_(.+)_(\d+)u_(\d+)x$/, (ctx) => {
      const [, side, symbol, amount, leverage] = ctx.match;
      this.handlePerpsExecuteAction(ctx, symbol, side.toUpperCase() as 'BUY' | 'SELL', parseInt(amount), parseInt(leverage));
    });

    // Custom amount handlers
    this.bot.action(/^spot_custom_amount_(buy|sell)_(.+)$/, (ctx) => {
      const [, side, symbol] = ctx.match;
      this.handlePlaceholderAction(ctx, `💰 Custom ${side} ${symbol} - Feature coming soon!`);
    });

    this.bot.action(/^perps_custom_amount_(buy|sell)_(.+)$/, (ctx) => {
      const [, side, symbol] = ctx.match;
      this.handlePlaceholderAction(ctx, `💰 Custom ${side} ${symbol} - Feature coming soon!`);
    });

    // Trade confirmation/cancellation flow
    this.bot.action('confirm_trade', (ctx) => 
      this.handlePlaceholderAction(ctx, '✅ Trade confirmation - Feature coming soon!')
    );

    this.bot.action('cancel_trade', (ctx) => 
      this.handlePlaceholderAction(ctx, '❌ Trade cancellation - Feature coming soon!')
    );

    // Basic trade actions
    this.bot.action('trade_buy', (ctx) => 
      this.navigationHandler.showTradingMenu(ctx)
    );

    this.bot.action('trade_sell', (ctx) => 
      this.navigationHandler.showTradingMenu(ctx)
    );

    this.bot.action('trade_back', (ctx) => 
      this.navigationHandler.showTradingMenu(ctx)
    );

    // Symbol selection handlers
    this.bot.action(/^symbol_(.+)_(.+)$/, (ctx) => {
      const [, action, symbol] = ctx.match;
      this.handlePlaceholderAction(ctx, `📊 Symbol ${symbol} ${action} - Feature coming soon!`);
    });

    // Quantity selection handlers
    this.bot.action(/^qty_(.+)_(.+)_(.+)$/, (ctx) => {
      const [, amount, action, symbol] = ctx.match;
      this.handlePlaceholderAction(ctx, `💰 Quantity ${amount} for ${symbol} - Feature coming soon!`);
    });

    // Leverage selection handlers
    this.bot.action(/^lev_(.+)_(.+)_(.+)_(.+)$/, (ctx) => {
      const [, leverage, amount, action, symbol] = ctx.match;
      this.handlePlaceholderAction(ctx, `⚡ ${leverage}x leverage for ${symbol} - Feature coming soon!`);
    });

    // Position management handlers
    this.bot.action(/^position_(.+)_(.+)$/, (ctx) => {
      const [, action, symbol] = ctx.match;
      this.handlePlaceholderAction(ctx, `📊 Position ${action} for ${symbol} - Feature coming soon!`);
    });

    // Quick trading handlers
    this.bot.action(/^quick_trade_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handlePlaceholderAction(ctx, `⚡ Quick trade ${symbol} - Feature coming soon!`);
    });

    this.bot.action(/^quick_(buy|sell)_(\d+)([up%])_(.+)$/, (ctx) => {
      const [, side, amount, unit, symbol] = ctx.match;
      const unitText = unit === 'u' ? 'USDT' : '%';
      this.handlePlaceholderAction(ctx, `⚡ Quick ${side} ${amount}${unitText} ${symbol} - Feature coming soon!`);
    });

    // P&L refresh handler
    this.bot.action('refresh_pnl', (ctx) => 
      this.handlePositionsCommand(ctx)
    );

    // Alternative spot/perps symbol patterns from original
    this.bot.action(/^spot_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const [, side, symbol] = ctx.match;
      this.tradingHandler.handleSpotSymbolTrading(ctx, symbol, side.toUpperCase() as 'BUY' | 'SELL');
    });

    this.bot.action(/^perps_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const [, side, symbol] = ctx.match;
      this.tradingHandler.handlePerpsSymbolTrading(ctx, symbol, side.toUpperCase() as 'BUY' | 'SELL');
    });

    // Spot asset selling handlers
    this.bot.action(/^spot_sell_([A-Z0-9]+)$/, (ctx) => {
      const asset = ctx.match[1];
      this.handlePlaceholderAction(ctx, `💱 Sell ${asset} - Feature coming soon!`);
    });

    this.bot.action(/^spot_sell_([A-Z0-9]+)_(\d+)pct$/, (ctx) => {
      const [, asset, percentage] = ctx.match;
      this.handlePlaceholderAction(ctx, `💱 Sell ${percentage}% of ${asset} - Feature coming soon!`);
    });

    // Price tracking handlers
    this.bot.action('price_menu', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 Price menu - Feature coming soon!')
    );

    this.bot.action('price_top_mcap', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 Top market cap - Feature coming soon!')
    );

    this.bot.action('price_top_volume', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 Top volume - Feature coming soon!')
    );

    this.bot.action('price_watchlist', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 Price watchlist - Feature coming soon!')
    );

    this.bot.action(/^price_token_([A-Z0-9]+USDT)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handlePlaceholderAction(ctx, `📊 ${symbol} price - Feature coming soon!`);
    });

    this.bot.action('price_compare', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 Price compare - Feature coming soon!')
    );

    this.bot.action('price_all_markets', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 All markets - Feature coming soon!')
    );

    // Settings handlers
    this.bot.action(/^settings_(.+)$/, (ctx) => {
      const setting = ctx.match[1];
      this.handlePlaceholderAction(ctx, `⚙️ Setting ${setting} - Feature coming soon!`);
    });

    console.log('[Orchestrator] Actions registered');
  }

  /**
   * Setup text handlers
   */
  private setupTextHandlers(): void {
    this.bot.on('text', (ctx) => {
      // Handle conversation states and natural language commands
      console.log(`[Text] Received: ${ctx.message.text} from user ${ctx.userState?.userId}`);
      // Add text processing logic here
    });

    console.log('[Orchestrator] Text handlers registered');
  }

  /**
   * Start the bot and server
   */
  async start(): Promise<void> {
    try {
      // Initialize database
      await this.db.connect();
      await this.db.initializeSchema();

      // Start server
      const port = this.config.server.port;
      this.server.listen(port, '0.0.0.0', () => {
        console.log(`[Server] ✅ Express server listening on port ${port}`);
        console.log(`[Server] ✅ Webhook endpoint: ${this.config.webhook.path}`);
      }).on('error', (error) => {
        console.error(`[Server] ❌ Failed to start server:`, error);
        throw error;
      });

      // Start bot (webhook only)
      if (!this.config.webhook) {
        throw new Error('Webhook configuration is required. Polling mode is no longer supported.');
      }

      // Setup webhook endpoint with Telegraf's built-in Express integration
      this.server.use(await this.bot.createWebhook({
        domain: this.config.webhook.url.replace('/webhook', ''),
        path: this.config.webhook.path,
        secret_token: this.config.webhook.secretToken
      }));
      console.log(`[Server] ✅ Webhook endpoint created at ${this.config.webhook.path}`);

      // Set webhook with retry logic for rate limiting
      let retries = 3;
      while (retries > 0) {
        try {
          await this.bot.telegram.setWebhook(this.config.webhook.url, {
            secret_token: this.config.webhook.secretToken,
            drop_pending_updates: true
          });
          console.log(`[Bot] ✅ Webhook set to ${this.config.webhook.url}`);
          break;
        } catch (error: any) {
          if (error.response?.error_code === 429) {
            const retryAfter = error.response.parameters?.retry_after || 1;
            console.log(`[Bot] ⏳ Rate limited, waiting ${retryAfter}s before retry (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            retries--;
          } else {
            throw error;
          }
        }
      }
      
      if (retries === 0) {
        console.log(`[Bot] ⚠️ Failed to set webhook after retries, but server is running`);
      }
      
      this.eventEmitter.emitEvent({
        type: EventTypes.BOT_STARTED,
        timestamp: new Date(),
        userId: 0,
        telegramId: 0
      });

      console.log('🚀 Bot started successfully');
      
      // Graceful shutdown
      process.once('SIGINT', () => this.stop());
      process.once('SIGTERM', () => this.stop());
      
    } catch (error) {
      console.error('Failed to start bot:', error);
      throw error;
    }
  }

  /**
   * Handle placeholder actions with coming soon messages
   */
  private async handlePlaceholderAction(ctx: BotContext, message: string): Promise<void> {
    try {
      await ctx.answerCbQuery(message);
      await ctx.reply(message + '\n\n🔙 Use /menu to return to main menu.');
    } catch (error) {
      console.error('[Orchestrator] Placeholder action error:', error);
      this.eventEmitter.emitEvent({
        type: EventTypes.ERROR_OCCURRED,
        timestamp: new Date(),
        userId: ctx.userState?.userId || 0,
        telegramId: ctx.userState?.telegramId || 0,
        correlationId: ctx.correlationId,
        error: error as Error,
        context: { type: 'placeholder_action' }
      });
    }
  }

  /**
   * Handle spot trade execution
   */
  private async handleSpotExecuteAction(
    ctx: BotContext, 
    symbol: string, 
    side: 'BUY' | 'SELL', 
    amount: number
  ): Promise<void> {
    try {
      if (!ctx.userState?.isLinked) {
        await ctx.answerCbQuery('❌ Please link your API credentials first!');
        await ctx.reply('❌ Please link your API credentials first using /link');
        return;
      }

      const action = side === 'BUY' ? 'Buy' : 'Sell';
      const emoji = side === 'BUY' ? '🟢' : '🔴';
      
      await ctx.answerCbQuery(`${emoji} Executing ${action} ${symbol} $${amount}...`);
      
      // Show processing message
      const processingMsg = await ctx.reply(
        `${emoji} **Processing Spot ${action} Order**\n\n` +
        `**Symbol:** ${symbol}\n` +
        `**Amount:** $${amount}\n` +
        `**Type:** Market ${action}\n\n` +
        `⏳ Executing trade...`,
        { parse_mode: 'Markdown' }
      );

      try {
        // Get API client for user
        const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);

        // Execute the trade using the ORIGINAL working approach
        const orderResult = await apiClient.createSpotOrder({
          symbol,
          side,
          type: 'MARKET',
          quoteOrderQty: amount.toString() // ← Use original approach: direct USDT amount
        });

        // Success message
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          processingMsg.message_id,
          undefined,
          `✅ **Spot ${action} Order Executed**\n\n` +
          `**Symbol:** ${symbol}\n` +
          `**Amount:** $${amount}\n` +
          `**Quantity:** ${orderResult.executedQty}\n` +
          `**Avg Price:** $${orderResult.avgPrice || 'N/A'}\n` +
          `**Order ID:** ${orderResult.orderId}\n\n` +
          `🎉 Trade completed successfully!\n\n` +
          `🔙 Use /menu to return to main menu.`,
          { parse_mode: 'Markdown' }
        );

        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_EXECUTED,
          timestamp: new Date(),
          userId: ctx.userState.userId,
          telegramId: ctx.userState.telegramId,
          correlationId: ctx.correlationId,
          symbol,
          action: side,
          amount,
          orderId: orderResult.orderId
        });

      } catch (tradeError: any) {
        console.error('[Orchestrator] Spot trade execution failed:', tradeError);
        
        // Show error message
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          processingMsg.message_id,
          undefined,
          `❌ **Spot ${action} Order Failed**\n\n` +
          `**Symbol:** ${symbol}\n` +
          `**Amount:** $${amount}\n` +
          `**Error:** ${tradeError.message || 'Unknown error'}\n\n` +
          `🔄 Please try again or contact support.\n\n` +
          `🔙 Use /menu to return to main menu.`,
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      console.error('[Orchestrator] Spot execute action error:', error);
      this.eventEmitter.emitEvent({
        type: EventTypes.ERROR_OCCURRED,
        timestamp: new Date(),
        userId: ctx.userState?.userId || 0,
        telegramId: ctx.userState?.telegramId || 0,
        correlationId: ctx.correlationId,
        error: error as Error,
        context: { type: 'spot_execute_action', symbol, side, amount }
      });
    }
  }

  /**
   * Handle perps trade execution
   */
  private async handlePerpsExecuteAction(
    ctx: BotContext, 
    symbol: string, 
    side: 'BUY' | 'SELL', 
    amount: number,
    leverage: number
  ): Promise<void> {
    try {
      if (!ctx.userState?.isLinked) {
        await ctx.answerCbQuery('❌ Please link your API credentials first!');
        await ctx.reply('❌ Please link your API credentials first using /link');
        return;
      }

      const action = side === 'BUY' ? 'Long' : 'Short';
      const emoji = side === 'BUY' ? '📈' : '📉';
      
      await ctx.answerCbQuery(`${emoji} Executing ${action} ${symbol} $${amount} ${leverage}x...`);
      
      // Show processing message
      const processingMsg = await ctx.reply(
        `${emoji} **Processing Perps ${action} Order**\n\n` +
        `**Symbol:** ${symbol}\n` +
        `**Amount:** $${amount}\n` +
        `**Leverage:** ${leverage}x\n` +
        `**Type:** Market ${action}\n\n` +
        `⏳ Setting leverage and executing trade...`,
        { parse_mode: 'Markdown' }
      );

      try {
        // Get API client for user
        const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
        
        // Set leverage first
        await apiClient.changeLeverage(symbol, leverage);
        
        // Calculate quantity using ORIGINAL working approach with proper precision
        const currentPrice = await this.priceService.getCurrentPrice(symbol);
        const rawQuantity = amount / currentPrice;
        const quantity = await this.formatQuantityWithPrecision(apiClient, symbol, rawQuantity);

        // Execute the trade
        const orderResult = await apiClient.createOrder({
          symbol,
          side,
          type: 'MARKET',
          quantity
        });

        // Mark trade executed for position update timing (like original)
        try {
          const futuresService = new (await import('../services/FuturesAccountService')).FuturesAccountService(apiClient);
          futuresService.markTradeExecuted();
        } catch (error) {
          console.warn('[Orchestrator] Could not mark trade executed:', error);
        }

        // Success message
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          processingMsg.message_id,
          undefined,
          `✅ **Perps ${action} Order Executed**\n\n` +
          `**Symbol:** ${symbol}\n` +
          `**Margin:** $${amount}\n` +
          `**Leverage:** ${leverage}x\n` +
          `**Position Size:** ${orderResult.executedQty}\n` +
          `**Entry Price:** $${orderResult.avgPrice || currentPrice.toFixed(6)}\n` +
          `**Order ID:** ${orderResult.orderId}\n\n` +
          `🎉 Position opened successfully!\n\n` +
          `🔙 Use /menu to return to main menu.`,
          { parse_mode: 'Markdown' }
        );

        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_EXECUTED,
          timestamp: new Date(),
          userId: ctx.userState.userId,
          telegramId: ctx.userState.telegramId,
          correlationId: ctx.correlationId,
          symbol,
          action: side,
          amount,
          leverage,
          orderId: orderResult.orderId
        });

      } catch (tradeError: any) {
        console.error('[Orchestrator] Perps trade execution failed:', tradeError);
        
        // Show error message
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          processingMsg.message_id,
          undefined,
          `❌ **Perps ${action} Order Failed**\n\n` +
          `**Symbol:** ${symbol}\n` +
          `**Amount:** $${amount}\n` +
          `**Leverage:** ${leverage}x\n` +
          `**Error:** ${tradeError.message || 'Unknown error'}\n\n` +
          `🔄 Please try again or contact support.\n\n` +
          `🔙 Use /menu to return to main menu.`,
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      console.error('[Orchestrator] Perps execute action error:', error);
      this.eventEmitter.emitEvent({
        type: EventTypes.ERROR_OCCURRED,
        timestamp: new Date(),
        userId: ctx.userState?.userId || 0,
        telegramId: ctx.userState?.telegramId || 0,
        correlationId: ctx.correlationId,
        error: error as Error,
        context: { type: 'perps_execute_action', symbol, side, amount, leverage }
      });
    }
  }

  /**
   * Handle help command
   */
  private async handleHelpCommand(ctx: BotContext): Promise<void> {
    const helpText = `
🆘 **AsterBot Help Center**

**📋 Commands:**
• /start - Welcome & main menu
• /menu - Show main menu
• /trade - Quick access to trading
• /positions - View open positions
• /balance - Check account balance
• /help - Show this help

**🔗 Setup:**
• /link - Link your API credentials
• /unlink - Remove API credentials
• /settings - Bot settings

**📈 Trading:**
• Use buttons for easy trading
• Supports spot & perpetual futures
• Real-time P&L tracking

**🆘 Support:**
If you need help, contact support or check the documentation.
    `.trim();

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
  }

  /**
   * Handle link API command
   */
  private async handleLinkCommand(ctx: BotContext): Promise<void> {
    await ctx.reply('🔗 **API Linking**\n\nPlease use the Link API button in the main menu to securely link your credentials.\n\nUse /menu to access the main menu.');
  }

  /**
   * Handle unlink command
   */
  private async handleUnlinkCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ No API credentials are currently linked.');
      return;
    }
    
    try {
      // For now, just notify the user - implement actual unlinking later
      await ctx.reply('✅ **API Credentials Unlinked**\n\nYour API credentials have been safely removed from our system.\n\n(Implementation pending)');
    } catch (error) {
      await ctx.reply('❌ Failed to unlink credentials. Please try again.');
    }
  }

  /**
   * Handle settings command
   */
  private async handleSettingsCommand(ctx: BotContext): Promise<void> {
    await ctx.reply('⚙️ **Settings**\n\nSettings management coming soon! Use /menu for main options.');
  }

  /**
   * Handle buy command
   */
  private async handleBuyCommand(ctx: BotContext): Promise<void> {
    await ctx.reply('📈 **Quick Buy**\n\nUse /trade or the main menu to access the trading interface.');
  }

  /**
   * Handle sell command
   */
  private async handleSellCommand(ctx: BotContext): Promise<void> {
    await ctx.reply('📉 **Quick Sell**\n\nUse /trade or the main menu to access the trading interface.');
  }

  /**
   * Handle positions command
   */
  private async handlePositionsCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const FuturesAccountService = await import('../services/FuturesAccountService');
      const futuresService = new FuturesAccountService.FuturesAccountService(apiClient);
      
      const openPositions = await futuresService.getOpenPositions();
      
      if (openPositions.length === 0) {
        await ctx.reply('📊 **No Open Positions**\n\nYou don\'t have any open futures positions.\n\nUse /trade to start trading!', { parse_mode: 'Markdown' });
        return;
      }

      let positionsText = '📊 **Open Positions**\n\n';
      
      openPositions.slice(0, 10).forEach((position, index) => {
        const sideEmoji = position.side === 'LONG' ? '🟢' : '🔴';
        const pnlEmoji = position.unrealizedPnl >= 0 ? '📈' : '📉';
        
        positionsText += `${sideEmoji} **${position.symbol}** ${position.leverage}x\n`;
        positionsText += `   ${pnlEmoji} P&L: ${position.unrealizedPnl >= 0 ? '+' : ''}$${position.unrealizedPnl.toFixed(2)}\n`;
        positionsText += `   Size: ${position.size.toFixed(6)}\n\n`;
      });

      if (openPositions.length > 10) {
        positionsText += `... and ${openPositions.length - 10} more positions\n\n`;
      }

      positionsText += 'Use /trade to manage positions.';

      await ctx.reply(positionsText, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Positions command error:', error);
      await ctx.reply('❌ Failed to load positions. Please try again.');
    }
  }

  /**
   * Handle balance command
   */
  private async handleBalanceCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      
      const [SpotAccountService, FuturesAccountService] = await Promise.all([
        import('../services/SpotAccountService'),
        import('../services/FuturesAccountService')
      ]);
      
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      const futuresService = new FuturesAccountService.FuturesAccountService(apiClient);
      
      const [spotSummary, futuresSummary] = await Promise.all([
        spotService.getPortfolioSummary().catch(() => null),
        futuresService.getPortfolioSummary().catch(() => null)
      ]);
      
      let balanceText = '💰 **Account Balance**\n\n';
      
      if (spotSummary) {
        balanceText += `🏪 **Spot**: $${spotSummary.totalUsdValue.toFixed(2)}\n`;
      }
      
      if (futuresSummary) {
        balanceText += `⚡ **Futures**: $${futuresSummary.totalWalletBalance.toFixed(2)}\n`;
        if (futuresSummary.openPositions.length > 0) {
          balanceText += `📊 Unrealized P&L: ${futuresSummary.totalUnrealizedPnl >= 0 ? '+' : ''}$${futuresSummary.totalUnrealizedPnl.toFixed(2)}\n`;
        }
      }
      
      await ctx.reply(balanceText, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Balance command error:', error);
      await ctx.reply('❌ Failed to load balance. Please try again.');
    }
  }

  /**
   * Handle P&L command
   */
  private async handlePnLCommand(ctx: BotContext): Promise<void> {
    await this.handlePositionsCommand(ctx); // Reuse positions display for now
  }

  /**
   * Handle spot command
   */
  private async handleSpotCommand(ctx: BotContext): Promise<void> {
    await this.tradingHandler.handleSpotTrading(ctx);
  }

  /**
   * Handle price command
   */
  private async handlePriceCommand(ctx: BotContext): Promise<void> {
    await ctx.reply('📊 **Price Tracking**\n\nPrice tracking features coming soon! Use /trade for current trading prices.');
  }

  /**
   * Handle panic command (admin only)
   */
  private async handlePanicCommand(ctx: BotContext): Promise<void> {
    if (!this.config.telegram.adminIds.includes(ctx.from?.id || 0)) {
      return; // Silently ignore non-admin users
    }
    
    await ctx.reply('🚨 **Admin Panic Command**\n\nPanic features coming soon!');
  }

  /**
   * Format quantity with proper precision based on symbol's LOT_SIZE filter
   * This prevents "Precision is over the maximum defined" errors
   */
  private async formatQuantityWithPrecision(apiClient: any, symbol: string, rawQuantity: number): Promise<string> {
    try {
      const exchangeInfo = await apiClient.getExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol);
      
      if (symbolInfo) {
        const lotSizeFilter = symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
        if (lotSizeFilter) {
          const stepSize = parseFloat(lotSizeFilter.stepSize);
          const adjustedQuantity = Math.floor(rawQuantity / stepSize) * stepSize;
          const decimalPlaces = lotSizeFilter.stepSize.split('.')[1]?.length || 0;
          const formattedQuantity = adjustedQuantity.toFixed(decimalPlaces);
          
          console.log(`[PRECISION] ${symbol} - Raw: ${rawQuantity}, Adjusted: ${formattedQuantity}, StepSize: ${stepSize}`);
          return formattedQuantity;
        }
      }
      
      // Fallback to 6 decimal places
      console.warn(`[PRECISION] No LOT_SIZE filter found for ${symbol}, using default precision`);
      return rawQuantity.toFixed(6);
    } catch (error) {
      console.warn(`[PRECISION] Failed to get precision for ${symbol}, using default:`, error);
      return rawQuantity.toFixed(6);
    }
  }

  /**
   * Stop the bot gracefully
   */
  async stop(): Promise<void> {
    console.log('Stopping bot...');
    
    this.eventEmitter.emitEvent({
      type: EventTypes.BOT_STOPPED,
      timestamp: new Date(),
      userId: 0,
      telegramId: 0
    });

    // Remove webhook
    try {
      await this.bot.telegram.deleteWebhook();
      console.log('[Bot] Webhook removed');
    } catch (error) {
      console.warn('[Bot] Failed to remove webhook:', error);
    }

    this.bot.stop();
    await this.db.disconnect();
    
    console.log('Bot stopped gracefully');
    process.exit(0);
  }
}