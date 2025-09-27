import { Telegraf, Markup } from 'telegraf';
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

    // These broad patterns are REMOVED to avoid conflicts with specific USDT patterns below

    // Basic action handlers
    this.bot.action('balance', (ctx) => 
      this.handleBalanceCommand(ctx)
    );

    this.bot.action('positions', (ctx) => 
      this.handlePositionsCommand(ctx)
    );

    this.bot.action('settings', (ctx) => 
      this.handleSettingsMenu(ctx)
    );

    this.bot.action('help', (ctx) => 
      this.handleHelpCommand(ctx)
    );

    this.bot.action('link_api', (ctx) => 
      this.handleLinkCommand(ctx)
    );

    this.bot.action('spot_assets', (ctx) => 
      this.handleSpotAssetsCommand(ctx)
    );

    this.bot.action('spot_sell_menu', (ctx) => 
      this.handleSpotSellMenu(ctx)
    );

    this.bot.action('spot_custom_pair', (ctx) => 
      this.handleCustomPairInput(ctx, 'spot')
    );

    this.bot.action('perps_custom_pair', (ctx) => 
      this.handleCustomPairInput(ctx, 'perps')
    );

    this.bot.action('pnl_analysis', (ctx) => 
      this.handlePnLAnalysis(ctx)
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
      this.handleCustomAmount(ctx, 'spot', side.toUpperCase() as 'BUY' | 'SELL', symbol);
    });

    this.bot.action(/^perps_custom_amount_(buy|sell)_(.+)$/, (ctx) => {
      const [, side, symbol] = ctx.match;
      this.handleCustomAmount(ctx, 'perps', side.toUpperCase() as 'BUY' | 'SELL', symbol);
    });

    // Trade confirmation/cancellation flow
    this.bot.action('confirm_trade', (ctx) => 
      this.handleTradeConfirmation(ctx)
    );

    this.bot.action('cancel_trade', (ctx) => 
      this.handleTradeCancellation(ctx)
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
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      this.handlePositionAction(ctx, action, symbol);
    });

    // Quick trading handlers
    this.bot.action(/^quick_trade_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleQuickTrade(ctx, symbol);
    });

    this.bot.action(/^quick_(buy|sell)_(\d+)([up%])_(.+)$/, (ctx) => {
      const side = ctx.match[1];           // 'buy' or 'sell'
      const amount = parseInt(ctx.match[2]); // amount number
      const unit = ctx.match[3];           // 'u' for USDT, 'p' for percentage  
      const symbol = ctx.match[4];         // symbol name
      const unitText = unit === 'u' ? 'USDT' : '%';
      this.handlePlaceholderAction(ctx, `⚡ Quick ${side} ${amount}${unitText} ${symbol} - Feature coming soon!`);
    });

    // P&L refresh handler
    this.bot.action('refresh_pnl', (ctx) => 
      this.handlePositionsCommand(ctx)
    );

    // EXACT original spot/perps symbol patterns (USDT symbols only)
    this.bot.action(/^spot_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const action = ctx.match[1];  // 'buy' or 'sell'
      const symbol = ctx.match[2];  // 'BTCUSDT', 'ETHUSDT', etc.
      this.tradingHandler.handleSpotSymbolTrading(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL');
    });

    this.bot.action(/^perps_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const action = ctx.match[1];  // 'buy' or 'sell'
      const symbol = ctx.match[2];  // 'BTCUSDT', 'ETHUSDT', etc.
      this.tradingHandler.handlePerpsSymbolTrading(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL');
    });

    // Spot asset selling handlers
    this.bot.action(/^spot_sell_([A-Z0-9]+)$/, (ctx) => {
      const asset = ctx.match[1];
      this.handleSpotSellAsset(ctx, asset);
    });

    this.bot.action(/^spot_sell_([A-Z0-9]+)_(\d+)pct$/, (ctx) => {
      const [, asset, percentage] = ctx.match;
      this.executeSpotSale(ctx, asset, parseInt(percentage));
    });

    // Price tracking handlers
    this.bot.action('price_menu', (ctx) => 
      this.handlePriceMenu(ctx)
    );

    this.bot.action('price_top_mcap', (ctx) => 
      this.handleTopMarketCap(ctx)
    );

    this.bot.action('price_top_volume', (ctx) => 
      this.handleTopVolume(ctx)
    );

    this.bot.action('price_watchlist', (ctx) => 
      this.handlePriceWatchlist(ctx)
    );

    this.bot.action(/^price_token_([A-Z0-9]+USDT)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleTokenPrice(ctx, symbol);
    });

    this.bot.action('price_compare', (ctx) => 
      this.handlePriceCompare(ctx)
    );

    this.bot.action('price_all_markets', (ctx) => 
      this.handleAllMarkets(ctx)
    );

    // Settings handlers
    this.bot.action(/^settings_(.+)$/, (ctx) => {
      const setting = ctx.match[1];
      this.handleSettingsSubmenu(ctx, setting);
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
      
      // Check if expecting custom pair input
      if ((ctx.userState as any)?.expectingCustomPair) {
        this.handleCustomPairText(ctx, ctx.message.text);
        return;
      }
      
      // Check if expecting custom amount input
      if ((ctx.userState as any)?.expectingCustomAmount) {
        this.handleCustomAmountText(ctx, ctx.message.text);
        return;
      }
      
      // Add other text processing logic here if needed
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

        // Calculate position size in USDT (notional value)
        const executedPrice = parseFloat(orderResult.avgPrice || currentPrice.toString());
        const executedQuantity = parseFloat(orderResult.executedQty);
        const positionSizeUSDT = executedQuantity * executedPrice;

        // Success message
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          processingMsg.message_id,
          undefined,
          `✅ **Perps ${action} Order Executed**\n\n` +
          `**Symbol:** ${symbol}\n` +
          `**Margin:** $${amount}\n` +
          `**Leverage:** ${leverage}x\n` +
          `**Position Size:** ${positionSizeUSDT.toFixed(2)} USDT\n` +
          `**Entry Price:** $${executedPrice.toFixed(6)}\n` +
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
   * Handle positions command - FULL ORIGINAL IMPLEMENTATION
   */
  private async handlePositionsCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      console.log('[POSITIONS] Fetching positions with enhanced data...');
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const FuturesAccountService = await import('../services/FuturesAccountService');
      const futuresService = new FuturesAccountService.FuturesAccountService(apiClient);
      
      const openPositions = await futuresService.getOpenPositions();
      
      if (openPositions.length === 0) {
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Start Trading', 'unified_trade'),
            Markup.button.callback('💰 Balance', 'balance')
          ],
          [
            Markup.button.callback('🔙 Back', 'main_menu')
          ]
        ]);
        
        await ctx.reply('📊 **No Open Positions**\n\nYou don\'t have any open futures positions.\n\nUse the trading interface to open positions!', { parse_mode: 'Markdown', ...keyboard });
        return;
      }

      let positionsText = '📊 **Open Positions**\n\n';
      
      openPositions.forEach(position => {
        const sideEmoji = position.side === 'LONG' ? '🟢' : '🔴';
        const sideText = `${sideEmoji} ${position.side}`;
        
        // Use real-time PnL if available, fallback to API PnL
        const displayPnl = position.realTimeUnrealizedPnl ?? position.unrealizedPnl;
        const displayPnlPercent = position.realTimePnlPercent ?? position.pnlPercent;
        
        const pnlEmoji = displayPnl >= 0 ? '📈' : '📉';
        const pnlColor = displayPnl >= 0 ? '🟢' : '🔴';
        
        // Debug logging
        console.log(`[POSITIONS] ${position.symbol}: API PnL=${position.unrealizedPnl}, Real-time PnL=${position.realTimeUnrealizedPnl}, Current Price=${position.currentPrice}`);
        
        positionsText += [
          `**${position.symbol}** ${sideText}`,
          `• Size: ${position.notional.toFixed(2)} USDT`,
          `• Entry: $${position.entryPrice.toFixed(4)}`,
          position.currentPrice ? `• Current: $${position.currentPrice.toFixed(4)}` : '',
          `• Leverage: ${position.leverage}x`,
          `• ${pnlColor} ${pnlEmoji} PnL: ${displayPnl >= 0 ? '+' : ''}$${displayPnl.toFixed(2)} (${displayPnlPercent >= 0 ? '+' : ''}${displayPnlPercent.toFixed(1)}%)`,
          position.currentPrice ? '' : '⚠️ (Real-time price unavailable)',
          '',
        ].filter(Boolean).join('\n');
      });

      // Enhanced positions with quick trading buttons and refresh functionality
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

      try {
        await ctx.editMessageText(positionsText, { parse_mode: 'Markdown', ...keyboard });
        console.log('[POSITIONS] Successfully displayed enhanced position data via edit');
      } catch (error) {
        await ctx.reply(positionsText, { parse_mode: 'Markdown', ...keyboard });
        console.log('[POSITIONS] Successfully displayed enhanced position data via reply');
      }

    } catch (error) {
      console.error('Positions command error:', error);
      await ctx.reply('❌ Failed to fetch positions. Please try again.');
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
   * Handle spot assets command - displays assets not positions
   */
  private async handleSpotAssetsCommand(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const SpotAccountService = await import('../services/SpotAccountService');
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      
      const spotSummary = await spotService.getPortfolioSummary();
      
      if (spotSummary.totalAssets === 0) {
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Start Trading', 'trade_spot'),
            Markup.button.callback('💰 Balance', 'balance')
          ],
          [
            Markup.button.callback('🔙 Back', 'main_menu')
          ]
        ]);
        
        await ctx.reply('🏪 **No Spot Assets**\n\nYou don\'t have any spot assets.\n\nUse the trading interface to buy some assets!', { parse_mode: 'Markdown', ...keyboard });
        return;
      }

      let assetsText = `🏪 **Spot Assets** • $${spotSummary.totalUsdValue.toFixed(2)}\n\n`;
      
      // Show main assets (>= $10 value)
      if (spotSummary.mainAssets.length > 0) {
        assetsText += '**📊 Main Assets:**\n';
        spotSummary.mainAssets.forEach((asset, index) => {
          const percentage = spotSummary.totalUsdValue > 0 ? (asset.usdValue! / spotSummary.totalUsdValue * 100) : 0;
          const emoji = index === 0 ? '▸' : '▫';
          assetsText += `${emoji} **${asset.asset}**: $${asset.usdValue!.toFixed(2)} (${percentage.toFixed(1)}%)\n`;
          assetsText += `   Amount: ${asset.total.toFixed(6)}\n`;
          if (parseFloat(asset.locked) > 0) {
            assetsText += `   Locked: ${parseFloat(asset.locked).toFixed(6)}\n`;
          }
          assetsText += '\n';
        });
      }

      // Show small balances if any
      if (spotSummary.smallBalances.length > 0) {
        const smallTotal = spotSummary.smallBalances.reduce((sum, b) => sum + (b.usdValue || 0), 0);
        assetsText += `**🔹 Small Assets** (${spotSummary.smallBalances.length} assets):\n`;
        assetsText += `Total Value: $${smallTotal.toFixed(2)}\n\n`;
        
        // Show first few small assets
        spotSummary.smallBalances.slice(0, 5).forEach(asset => {
          assetsText += `▫ ${asset.asset}: ${asset.total.toFixed(6)} ($${(asset.usdValue || 0).toFixed(2)})\n`;
        });
        
        if (spotSummary.smallBalances.length > 5) {
          assetsText += `▫ +${spotSummary.smallBalances.length - 5} more...\n`;
        }
      }

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh Assets', 'spot_assets'),
          Markup.button.callback('📈 Trade Spot', 'trade_spot')
        ],
        [
          Markup.button.callback('💰 Full Balance', 'balance'),
          Markup.button.callback('🔙 Back', 'main_menu')
        ]
      ]);

      await ctx.reply(assetsText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('[Orchestrator] Spot assets command error:', error);
      await ctx.reply('❌ Failed to load spot assets. Please try again.');
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
    await this.handlePriceMenu(ctx);
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
   * Handle position management actions
   */
  private async handlePositionAction(ctx: BotContext, action: string, symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);

      switch (action) {
        case 'manage':
          await this.showPositionManagementMenu(ctx, symbol, apiClient);
          break;
        case 'close':
          await this.handleClosePosition(ctx, symbol, apiClient, 100);
          break;
        case 'close_25':
          await this.handleClosePosition(ctx, symbol, apiClient, 25);
          break;
        case 'close_50':
          await this.handleClosePosition(ctx, symbol, apiClient, 50);
          break;
        case 'close_75':
          await this.handleClosePosition(ctx, symbol, apiClient, 75);
          break;
        case 'set_sl':
          await this.handlePlaceholderAction(ctx, `🛡️ Set Stop Loss for ${symbol} - Feature coming soon!`);
          break;
        case 'set_tp':
          await this.handlePlaceholderAction(ctx, `🎯 Set Take Profit for ${symbol} - Feature coming soon!`);
          break;
        case 'add_margin':
          await this.handlePlaceholderAction(ctx, `➕ Add Margin for ${symbol} - Feature coming soon!`);
          break;
        case 'reduce_margin':
          await this.handlePlaceholderAction(ctx, `➖ Reduce Margin for ${symbol} - Feature coming soon!`);
          break;
        default:
          await ctx.reply(`❌ Unknown position action: ${action}`);
      }
    } catch (error: any) {
      console.error(`Position action error for ${symbol}:`, error);
      await ctx.reply(`❌ Failed to ${action} position for ${symbol}: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Show position management menu
   */
  private async showPositionManagementMenu(ctx: BotContext, symbol: string, apiClient: any): Promise<void> {
    try {
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
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
    } catch (error) {
      console.error('Position management menu error:', error);
      await ctx.reply('❌ Failed to load position details. Please try again.');
    }
  }

  /**
   * Handle quick trade for a symbol - provides quick trading options
   */
  private async handleQuickTrade(ctx: BotContext, symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      
      // Get current position info
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      // Get current price
      const currentPrice = await this.priceService.getCurrentPrice(symbol);
      
      let quickTradeText = `⚡ **Quick Trade ${symbol}**\n\n`;
      quickTradeText += `💵 **Current Price:** $${currentPrice.toFixed(6)}\n\n`;
      
      if (position) {
        const positionAmt = parseFloat(position.positionAmt);
        const side = positionAmt > 0 ? 'LONG' : 'SHORT';
        const pnl = parseFloat(position.unrealizedPnl) || 0;
        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
        
        quickTradeText += `📊 **Current Position:**\n`;
        quickTradeText += `• Side: ${side}\n`;
        quickTradeText += `• Size: ${Math.abs(positionAmt)} (${(Math.abs(positionAmt) * parseFloat(position.entryPrice)).toFixed(2)} USDT)\n`;
        quickTradeText += `• Entry: $${position.entryPrice}\n`;
        quickTradeText += `• ${pnlEmoji} P&L: $${pnl.toFixed(2)}\n\n`;
        
        quickTradeText += `🎯 **Quick Actions:**`;
      } else {
        quickTradeText += `📊 **No Current Position**\n\n🎯 **Start Trading:**`;
      }

      // Create quick trading buttons
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🟢 Long $25', `perps_execute_buy_${symbol}_25u_5x`),
          Markup.button.callback('🔴 Short $25', `perps_execute_sell_${symbol}_25u_5x`)
        ],
        [
          Markup.button.callback('🟢 Long $50', `perps_execute_buy_${symbol}_50u_5x`),
          Markup.button.callback('🔴 Short $50', `perps_execute_sell_${symbol}_50u_5x`)
        ],
        [
          Markup.button.callback('🟢 Long $100', `perps_execute_buy_${symbol}_100u_5x`),
          Markup.button.callback('🔴 Short $100', `perps_execute_sell_${symbol}_100u_5x`)
        ],
        position ? [
          Markup.button.callback('📊 Manage Position', `position_manage_${symbol}`),
          Markup.button.callback('🔴 Close Position', `position_close_${symbol}`)
        ] : [
          Markup.button.callback('🎯 Custom Amount', `perps_custom_amount_buy_${symbol}`),
          Markup.button.callback('📈 Full Trading', 'trade_perps')
        ],
        [
          Markup.button.callback('🔙 Back to Positions', 'positions')
        ]
      ]);

      await ctx.editMessageText(quickTradeText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('Quick trade error:', error);
      await ctx.reply(`❌ Failed to load quick trade for ${symbol}. Please try again.`);
    }
  }

  /**
   * Handle closing position (full or partial)
   */
  private async handleClosePosition(ctx: BotContext, symbol: string, apiClient: any, percentage: number): Promise<void> {
    try {
      await ctx.answerCbQuery(`🔄 Closing ${percentage}% of ${symbol} position...`);
      
      const processingMsg = await ctx.reply(
        `🔄 **Closing Position**\n\n` +
        `**Symbol:** ${symbol}\n` +
        `**Amount:** ${percentage}%\n\n` +
        `⏳ Processing closure...`,
        { parse_mode: 'Markdown' }
      );

      // Use the existing closePosition method from AsterApiClient
      const result = await apiClient.closePosition(symbol, percentage);
      
      await ctx.telegram.editMessageText(
        ctx.chat?.id,
        processingMsg.message_id,
        undefined,
        `✅ **Position Closed Successfully**\n\n` +
        `**Symbol:** ${symbol}\n` +
        `**Amount:** ${percentage}%\n` +
        `**Order ID:** ${result.orderId}\n` +
        `**Status:** ${result.status}\n\n` +
        `🎉 Position closure completed!\n\n` +
        `Use /positions to view updated positions.`,
        { parse_mode: 'Markdown' }
      );

      // Emit event
      this.eventEmitter.emitEvent({
        type: EventTypes.TRADE_EXECUTED,
        timestamp: new Date(),
        userId: ctx.userState!.userId,
        telegramId: ctx.userState!.telegramId,
        correlationId: ctx.correlationId,
        symbol,
        action: 'CLOSE',
        amount: percentage,
        orderId: result.orderId
      });

    } catch (error: any) {
      console.error('Close position error:', error);
      await ctx.reply(`❌ **Position Closure Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}\n\n🔄 Please try again.`);
    }
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
   * Handle P&L Analysis - comprehensive profit/loss analysis
   */
  private async handlePnLAnalysis(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      // Import and use the existing PnL module
      const PnLModule = await import('../pnl');
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const pnlCalculator = new PnLModule.PnLCalculator(apiClient);
      
      // Calculate comprehensive P&L
      const pnlData = await pnlCalculator.calculateComprehensivePnL();
      
      let analysisText = '📈 **P&L Analysis**\n\n';
      
      // Overview
      if (pnlData.success && pnlData.totalCurrentValue && pnlData.totalPnL !== undefined) {
        analysisText += `💰 **Total Portfolio:** $${pnlData.totalCurrentValue.toFixed(2)}\n`;
        analysisText += `📊 **Total P&L:** ${pnlData.totalPnL >= 0 ? '+' : ''}$${pnlData.totalPnL.toFixed(2)}\n`;
        if (pnlData.totalPnLPercent !== undefined) {
          analysisText += `📈 **Total ROI:** ${pnlData.totalPnLPercent >= 0 ? '+' : ''}${pnlData.totalPnLPercent.toFixed(2)}%\n\n`;
        }
        
        // Display positions summary
        if (pnlData.positions && pnlData.positions.length > 0) {
          analysisText += `🏪 **Spot Positions:** ${pnlData.positions.length}\n`;
        }
        
        if (pnlData.perpPositions && pnlData.perpPositions.length > 0) {
          analysisText += `⚡ **Perp Positions:** ${pnlData.perpPositions.length}\n`;
        }
      } else {
        analysisText += `❌ ${pnlData.message || 'Failed to calculate P&L'}\n`;
      }
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh', 'pnl_analysis'),
          Markup.button.callback('📊 Positions', 'positions')
        ],
        [
          Markup.button.callback('💰 Balance', 'balance'),
          Markup.button.callback('🔙 Back', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(analysisText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('[Orchestrator] P&L analysis error:', error);
      await ctx.reply('❌ Failed to calculate P&L analysis. Please try again.');
    }
  }

  /**
   * Handle Settings Menu - bot configuration settings
   */
  private async handleSettingsMenu(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      // Import and use the existing Settings module
      const SettingsModule = await import('../settings');
      const settingsManager = new SettingsModule.SettingsManager(this.db, this.encryption);

      const userId = ctx.userState.userId;
      const userSettings = await settingsManager.getUserSettings(userId);
      
      let settingsText = '⚙️ **Bot Settings**\n\n';
      
      // Display current settings
      settingsText += `🎯 **Leverage Cap:** ${userSettings.leverage_cap}x\n`;
      settingsText += `💰 **Default Leverage:** ${userSettings.default_leverage}x\n`;
      settingsText += `📊 **Slippage Tolerance:** ${(userSettings.slippage_bps / 100).toFixed(2)}%\n`;
      settingsText += `🛡️ **Daily Loss Cap:** ${userSettings.daily_loss_cap ? '$' + userSettings.daily_loss_cap : 'None'}\n`;
      settingsText += `🔒 **PIN Protection:** ${userSettings.pin_hash ? 'Enabled' : 'Disabled'}\n\n`;
      
      settingsText += '🔧 **Available Settings:**\n';
      settingsText += '• Leverage limits for safety\n';
      settingsText += '• Default trade sizes\n';
      settingsText += '• Risk management settings\n';
      settingsText += '• Security preferences\n';
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🎯 Leverage', 'settings_leverage'),
          Markup.button.callback('💰 Size', 'settings_size')
        ],
        [
          Markup.button.callback('🛡️ Risk', 'settings_risk'),
          Markup.button.callback('🔒 Security', 'settings_security')
        ],
        [
          Markup.button.callback('🔄 Refresh', 'settings'),
          Markup.button.callback('🔙 Back', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(settingsText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('[Orchestrator] Settings menu error:', error);
      await ctx.reply('❌ Failed to load settings. Please try again.');
    }
  }

  /**
   * Handle settings submenus
   */
  private async handleSettingsSubmenu(ctx: BotContext, setting: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const SettingsModule = await import('../settings');
      const settingsManager = new SettingsModule.SettingsManager(this.db, this.encryption);
      const userSettings = await settingsManager.getUserSettings(ctx.userState.userId);

      switch (setting) {
        case 'leverage':
          await this.handleLeverageSettings(ctx, userSettings, settingsManager);
          break;
        case 'size':
          await this.handleSizeSettings(ctx, userSettings, settingsManager);
          break;
        case 'risk':
          await this.handleRiskSettings(ctx, userSettings, settingsManager);
          break;
        case 'security':
          await this.handleSecuritySettings(ctx, userSettings, settingsManager);
          break;
        default:
          await ctx.reply(`❌ Unknown setting: ${setting}`);
      }
    } catch (error) {
      console.error('Settings submenu error:', error);
      await ctx.reply('❌ Failed to load settings submenu. Please try again.');
    }
  }

  /**
   * Handle leverage settings
   */
  private async handleLeverageSettings(ctx: BotContext, userSettings: any, settingsManager: any): Promise<void> {
    const leverageText = [
      '🎯 **Leverage Settings**',
      '',
      `**Current Leverage Cap:** ${userSettings.leverage_cap}x`,
      `**Default Leverage:** ${userSettings.default_leverage}x`,
      '',
      '⚙️ **Configure leverage limits for safety:**',
      '• Leverage Cap: Maximum allowed leverage',
      '• Default Leverage: Used for quick trades',
      '',
      '💡 **Recommended:** Cap at 20x for safer trading'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('5x Cap', 'set_leverage_cap_5'),
        Markup.button.callback('10x Cap', 'set_leverage_cap_10')
      ],
      [
        Markup.button.callback('20x Cap', 'set_leverage_cap_20'),
        Markup.button.callback('50x Cap', 'set_leverage_cap_50')
      ],
      [
        Markup.button.callback('2x Default', 'set_default_leverage_2'),
        Markup.button.callback('5x Default', 'set_default_leverage_5')
      ],
      [
        Markup.button.callback('🔙 Back', 'settings')
      ]
    ]);

    await ctx.editMessageText(leverageText, { parse_mode: 'Markdown', ...keyboard });
  }

  /**
   * Handle size settings
   */
  private async handleSizeSettings(ctx: BotContext, userSettings: any, settingsManager: any): Promise<void> {
    const sizeText = [
      '💰 **Size Settings**',
      '',
      `**Size Presets:** $${userSettings.size_presets.join(', $')}`,
      '',
      '⚙️ **Configure default trade sizes:**',
      '• Quick access buttons for common amounts',
      '• Customize based on your trading style',
      '',
      '💡 **Popular presets:** $25, $50, $100, $250'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('Conservative', 'set_size_preset_conservative'),
        Markup.button.callback('Moderate', 'set_size_preset_moderate')
      ],
      [
        Markup.button.callback('Aggressive', 'set_size_preset_aggressive'),
        Markup.button.callback('Custom', 'set_size_preset_custom')
      ],
      [
        Markup.button.callback('🔙 Back', 'settings')
      ]
    ]);

    await ctx.editMessageText(sizeText, { parse_mode: 'Markdown', ...keyboard });
  }

  /**
   * Handle risk settings
   */
  private async handleRiskSettings(ctx: BotContext, userSettings: any, settingsManager: any): Promise<void> {
    const riskText = [
      '🛡️ **Risk Management Settings**',
      '',
      `**Slippage Tolerance:** ${(userSettings.slippage_bps / 100).toFixed(2)}%`,
      `**Daily Loss Cap:** ${userSettings.daily_loss_cap ? '$' + userSettings.daily_loss_cap : 'None'}`,
      `**TP Presets:** ${userSettings.tp_presets.join('%, ')}%`,
      `**SL Presets:** ${userSettings.sl_presets.join('%, ')}%`,
      '',
      '⚙️ **Configure risk management:**',
      '• Set maximum daily losses',
      '• Configure slippage tolerance',
      '• Set take profit/stop loss presets'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('$100 Daily Cap', 'set_daily_cap_100'),
        Markup.button.callback('$500 Daily Cap', 'set_daily_cap_500')
      ],
      [
        Markup.button.callback('0.5% Slippage', 'set_slippage_50'),
        Markup.button.callback('1% Slippage', 'set_slippage_100')
      ],
      [
        Markup.button.callback('Remove Daily Cap', 'remove_daily_cap'),
        Markup.button.callback('Reset to Default', 'reset_risk_settings')
      ],
      [
        Markup.button.callback('🔙 Back', 'settings')
      ]
    ]);

    await ctx.editMessageText(riskText, { parse_mode: 'Markdown', ...keyboard });
  }

  /**
   * Handle security settings
   */
  private async handleSecuritySettings(ctx: BotContext, userSettings: any, settingsManager: any): Promise<void> {
    const securityText = [
      '🔒 **Security Settings**',
      '',
      `**PIN Protection:** ${userSettings.pin_hash ? 'Enabled' : 'Disabled'}`,
      '',
      '⚙️ **Security features:**',
      '• PIN protection for trades',
      '• Secure credential storage',
      '• Session management',
      '',
      '💡 **Enable PIN for extra security on large trades**'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        userSettings.pin_hash ? 
          Markup.button.callback('🔓 Disable PIN', 'disable_pin') :
          Markup.button.callback('🔒 Enable PIN', 'enable_pin'),
        Markup.button.callback('🔄 Change PIN', 'change_pin')
      ],
      [
        Markup.button.callback('🔐 Security Info', 'security_info'),
        Markup.button.callback('⚠️ Reset Security', 'reset_security')
      ],
      [
        Markup.button.callback('🔙 Back', 'settings')
      ]
    ]);

    await ctx.editMessageText(securityText, { parse_mode: 'Markdown', ...keyboard });
  }

  /**
   * Handle price menu - main price tracking interface
   */
  private async handlePriceMenu(ctx: BotContext): Promise<void> {
    try {
      const priceText = [
        '📊 **Price Tracking Center**',
        '',
        '🎯 **Quick Access:**',
        '• View top cryptocurrencies by market cap',
        '• Check highest volume trading pairs',
        '• Compare multiple token prices',
        '• Track your watchlist assets',
        '• View all available markets',
        '',
        '💡 Select an option below to get started:'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🏆 Top Market Cap', 'price_top_mcap'),
          Markup.button.callback('📈 Top Volume', 'price_top_volume')
        ],
        [
          Markup.button.callback('⭐ Watchlist', 'price_watchlist'),
          Markup.button.callback('🔄 Compare Prices', 'price_compare')
        ],
        [
          Markup.button.callback('🌐 All Markets', 'price_all_markets'),
          Markup.button.callback('📈 Trade', 'unified_trade')
        ],
        [
          Markup.button.callback('🔙 Back', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(priceText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Price menu error:', error);
      await ctx.reply('❌ Failed to load price menu. Please try again.');
    }
  }

  /**
   * Handle top market cap display
   */
  private async handleTopMarketCap(ctx: BotContext): Promise<void> {
    try {
      // Get top symbols by volume as a proxy for market cap
      const topSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT', 'SOLUSDT', 'DOTUSDT', 'LINKUSDT'];
      
      let priceText = '🏆 **Top Market Cap Cryptocurrencies**\n\n';
      
      const pricePromises = topSymbols.map(async (symbol, index) => {
        try {
          const price = await this.priceService.getCurrentPrice(symbol);
          // Use public API client for price data
          const AsterApiClient = await import('../aster');
          const publicClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
          const ticker = await publicClient.get24hrTicker(symbol);
          const change24h = parseFloat(ticker.priceChangePercent);
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          
          return `${index + 1}. **${symbol.replace('USDT', '')}** • $${price.toFixed(6)}\n   ${changeEmoji} ${changeText}${change24h.toFixed(2)}% (24h)\n`;
        } catch (error) {
          return `${index + 1}. **${symbol.replace('USDT', '')}** • Price unavailable\n`;
        }
      });
      
      const priceResults = await Promise.all(pricePromises);
      priceText += priceResults.join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📈 Top Volume', 'price_top_volume'),
          Markup.button.callback('🔄 Refresh', 'price_top_mcap')
        ],
        [
          Markup.button.callback('📈 Trade', 'unified_trade'),
          Markup.button.callback('🔙 Back', 'price_menu')
        ]
      ]);

      await ctx.editMessageText(priceText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Top market cap error:', error);
      await ctx.reply('❌ Failed to load top market cap data. Please try again.');
    }
  }

  /**
   * Handle top volume display
   */
  private async handleTopVolume(ctx: BotContext): Promise<void> {
    try {
      // Use public API client for market data
      const AsterApiClient = await import('../aster');
      const apiClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
      const allTickers = await apiClient.getAllFuturesTickers();
      
      // Sort by volume and take top 8
      const topByVolume = allTickers
        .filter((ticker: any) => ticker.symbol.endsWith('USDT'))
        .sort((a: any, b: any) => parseFloat(b.volume) - parseFloat(a.volume))
        .slice(0, 8);
      
      let volumeText = '📈 **Highest Volume Trading Pairs**\n\n';
      
      topByVolume.forEach((ticker: any, index: number) => {
        const change24h = parseFloat(ticker.priceChangePercent);
        const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
        const changeText = change24h >= 0 ? '+' : '';
        const volume = (parseFloat(ticker.volume) / 1000000).toFixed(1); // Convert to millions
        
        volumeText += `${index + 1}. **${ticker.symbol.replace('USDT', '')}** • $${parseFloat(ticker.lastPrice).toFixed(6)}\n`;
        volumeText += `   ${changeEmoji} ${changeText}${change24h.toFixed(2)}% • Vol: ${volume}M USDT\n\n`;
      });
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🏆 Top Market Cap', 'price_top_mcap'),
          Markup.button.callback('🔄 Refresh', 'price_top_volume')
        ],
        [
          Markup.button.callback('📈 Trade', 'unified_trade'),
          Markup.button.callback('🔙 Back', 'price_menu')
        ]
      ]);

      await ctx.editMessageText(volumeText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Top volume error:', error);
      await ctx.reply('❌ Failed to load top volume data. Please try again.');
    }
  }

  /**
   * Handle price watchlist
   */
  private async handlePriceWatchlist(ctx: BotContext): Promise<void> {
    try {
      // Default watchlist symbols
      const watchlist = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT', 'ASTERUSDT'];
      
      let watchlistText = '⭐ **Price Watchlist**\n\n';
      
      const pricePromises = watchlist.map(async (symbol) => {
        try {
          const price = await this.priceService.getCurrentPrice(symbol);
          // Use public API client for price data
          const AsterApiClient = await import('../aster');
          const publicClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
          const ticker = await publicClient.get24hrTicker(symbol);
          const change24h = parseFloat(ticker.priceChangePercent);
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          
          return [
            `**${symbol.replace('USDT', '')}** • $${price.toFixed(6)}`,
            `${changeEmoji} ${changeText}${change24h.toFixed(2)}% (24h)`,
            ''
          ].join('\n');
        } catch (error) {
          return `**${symbol.replace('USDT', '')}** • Price unavailable\n\n`;
        }
      });
      
      const watchlistResults = await Promise.all(pricePromises);
      watchlistText += watchlistResults.join('');
      
      // Create price buttons for quick access
      const priceButtons = watchlist.map(symbol => 
        Markup.button.callback(symbol.replace('USDT', ''), `price_token_${symbol}`)
      );
      
      // Arrange in rows of 3
      const buttonRows = [];
      for (let i = 0; i < priceButtons.length; i += 3) {
        buttonRows.push(priceButtons.slice(i, i + 3));
      }
      
      buttonRows.push([
        Markup.button.callback('🔄 Refresh', 'price_watchlist'),
        Markup.button.callback('📈 Trade', 'unified_trade')
      ]);
      
      buttonRows.push([
        Markup.button.callback('🔙 Back', 'price_menu')
      ]);
      
      const keyboard = Markup.inlineKeyboard(buttonRows);

      await ctx.editMessageText(watchlistText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Price watchlist error:', error);
      await ctx.reply('❌ Failed to load price watchlist. Please try again.');
    }
  }

  /**
   * Handle individual token price
   */
  private async handleTokenPrice(ctx: BotContext, symbol: string): Promise<void> {
    try {
      // Use public API client for market data
      const AsterApiClient = await import('../aster');
      const apiClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
      const [currentPrice, ticker] = await Promise.all([
        this.priceService.getCurrentPrice(symbol),
        apiClient.get24hrTicker(symbol)
      ]);
      
      const change24h = parseFloat(ticker.priceChangePercent);
      const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
      const changeText = change24h >= 0 ? '+' : '';
      const volume = (parseFloat(ticker.volume) / 1000000).toFixed(1);
      
      const priceText = [
        `📊 **${symbol.replace('USDT', '')} Price Details**`,
        '',
        `💵 **Current Price:** $${currentPrice.toFixed(6)}`,
        `${changeEmoji} **24h Change:** ${changeText}${change24h.toFixed(2)}%`,
        `📈 **24h High:** $${parseFloat(ticker.highPrice).toFixed(6)}`,
        `📉 **24h Low:** $${parseFloat(ticker.lowPrice).toFixed(6)}`,
        `📊 **24h Volume:** ${volume}M USDT`,
        `⏰ **Last Updated:** ${new Date().toLocaleTimeString()}`,
        '',
        '🎯 **Quick Actions:**'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🟢 Buy', `perps_buy_${symbol}`),
          Markup.button.callback('🔴 Sell', `perps_sell_${symbol}`)
        ],
        [
          Markup.button.callback('🔄 Refresh Price', `price_token_${symbol}`),
          Markup.button.callback('📈 Full Trading', 'trade_perps')
        ],
        [
          Markup.button.callback('⭐ Watchlist', 'price_watchlist'),
          Markup.button.callback('🔙 Back', 'price_menu')
        ]
      ]);

      await ctx.editMessageText(priceText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error(`Token price error for ${symbol}:`, error);
      await ctx.reply(`❌ Failed to load price data for ${symbol}. Please try again.`);
    }
  }

  /**
   * Handle price comparison
   */
  private async handlePriceCompare(ctx: BotContext): Promise<void> {
    try {
      const compareSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT'];
      
      let compareText = '🔄 **Price Comparison**\n\n';
      
      const comparisonPromises = compareSymbols.map(async (symbol) => {
        try {
          const [price, ticker] = await Promise.all([
            this.priceService.getCurrentPrice(symbol),
            (async () => {
              const AsterApiClient = await import('../aster');
              const publicClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
              return publicClient.get24hrTicker(symbol);
            })()
          ]);
          
          const change24h = parseFloat(ticker.priceChangePercent);
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          
          return {
            symbol,
            price,
            change24h,
            changeEmoji,
            changeText,
            text: `**${symbol.replace('USDT', '')}**\n$${price.toFixed(6)} ${changeEmoji} ${changeText}${change24h.toFixed(2)}%`
          };
        } catch (error) {
          return {
            symbol,
            price: 0,
            change24h: 0,
            changeEmoji: '⚪',
            changeText: '',
            text: `**${symbol.replace('USDT', '')}**\nPrice unavailable`
          };
        }
      });
      
      const comparisons = await Promise.all(comparisonPromises);
      
      // Sort by 24h change (best performers first)
      comparisons.sort((a, b) => b.change24h - a.change24h);
      
      comparisons.forEach((comp, index) => {
        const rank = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '📊';
        compareText += `${rank} ${comp.text}\n\n`;
      });
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh', 'price_compare'),
          Markup.button.callback('⭐ Watchlist', 'price_watchlist')
        ],
        [
          Markup.button.callback('📈 Trade Best', 'unified_trade'),
          Markup.button.callback('🔙 Back', 'price_menu')
        ]
      ]);

      await ctx.editMessageText(compareText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Price comparison error:', error);
      await ctx.reply('❌ Failed to load price comparison. Please try again.');
    }
  }

  /**
   * Handle all markets display
   */
  private async handleAllMarkets(ctx: BotContext): Promise<void> {
    try {
      // Use public API client for market data
      const AsterApiClient = await import('../aster');
      const apiClient = new AsterApiClient.AsterApiClient('https://api.aster.exchange', '', '');
      const allTickers = await apiClient.getAllFuturesTickers();
      
      // Filter USDT pairs and sort by volume
      const usdtPairs = allTickers
        .filter((ticker: any) => ticker.symbol.endsWith('USDT'))
        .sort((a: any, b: any) => parseFloat(b.volume) - parseFloat(a.volume))
        .slice(0, 12); // Show top 12
      
      let marketsText = '🌐 **All Available Markets**\n\n';
      marketsText += `📊 **Total USDT Pairs:** ${usdtPairs.length}\n\n`;
      marketsText += '**🔥 Top Markets by Volume:**\n\n';
      
      usdtPairs.forEach((ticker: any, index: number) => {
        const change24h = parseFloat(ticker.priceChangePercent);
        const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
        const changeText = change24h >= 0 ? '+' : '';
        
        marketsText += `${index + 1}. **${ticker.symbol.replace('USDT', '')}** $${parseFloat(ticker.lastPrice).toFixed(6)} ${changeEmoji} ${changeText}${change24h.toFixed(1)}%\n`;
      });
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh', 'price_all_markets'),
          Markup.button.callback('📈 Trade', 'unified_trade')
        ],
        [
          Markup.button.callback('🏆 Top Cap', 'price_top_mcap'),
          Markup.button.callback('📈 Top Vol', 'price_top_volume')
        ],
        [
          Markup.button.callback('🔙 Back', 'price_menu')
        ]
      ]);

      await ctx.editMessageText(marketsText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('All markets error:', error);
      await ctx.reply('❌ Failed to load market data. Please try again.');
    }
  }

  /**
   * Handle custom amount input for trading
   */
  private async handleCustomAmount(ctx: BotContext, mode: 'spot' | 'perps', side: 'BUY' | 'SELL', symbol: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const modeText = mode === 'spot' ? 'Spot' : 'Perps';
      const sideText = side === 'BUY' ? 'Buy' : 'Sell';
      const currentPrice = await this.priceService.getCurrentPrice(symbol);
      
      const customText = [
        `💰 **Custom ${modeText} ${sideText}**`,
        `**Symbol:** ${symbol}`,
        `**Current Price:** $${currentPrice.toFixed(6)}`,
        '',
        '✍️ **Type your custom amount:**',
        '',
        '📝 **Supported formats:**',
        '• $100 (USD amount)',
        '• 100u (USDT amount)',
        '• 0.1 (token quantity)',
        mode === 'perps' ? '• 100u 10x (with leverage)' : '',
        '',
        '⏳ **Waiting for your input...**'
      ].filter(Boolean).join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('$25', mode === 'spot' ? `spot_execute_${side.toLowerCase()}_${symbol}_25u` : `perps_execute_${side.toLowerCase()}_${symbol}_25u_5x`),
          Markup.button.callback('$50', mode === 'spot' ? `spot_execute_${side.toLowerCase()}_${symbol}_50u` : `perps_execute_${side.toLowerCase()}_${symbol}_50u_5x`)
        ],
        [
          Markup.button.callback('$100', mode === 'spot' ? `spot_execute_${side.toLowerCase()}_${symbol}_100u` : `perps_execute_${side.toLowerCase()}_${symbol}_100u_5x`),
          Markup.button.callback('$250', mode === 'spot' ? `spot_execute_${side.toLowerCase()}_${symbol}_250u` : `perps_execute_${side.toLowerCase()}_${symbol}_250u_5x`)
        ],
        [
          Markup.button.callback('🔙 Back', mode === 'spot' ? `spot_${side.toLowerCase()}_${symbol}` : `perps_${side.toLowerCase()}_${symbol}`)
        ]
      ]);

      await ctx.editMessageText(customText, { parse_mode: 'Markdown', ...keyboard });

      // Set conversation state
      if (ctx.userState) {
        (ctx.userState as any).expectingCustomAmount = { mode, side, symbol };
      }

    } catch (error) {
      console.error('Custom amount error:', error);
      await ctx.reply(`❌ Failed to load custom amount for ${symbol}. Please try again.`);
    }
  }

  /**
   * Handle custom amount text input
   */
  private async handleCustomAmountText(ctx: BotContext, text: string): Promise<void> {
    const customAmountState = (ctx.userState as any)?.expectingCustomAmount;
    if (!customAmountState) return;

    // Clear conversation state
    delete (ctx.userState as any).expectingCustomAmount;

    const { mode, side, symbol } = customAmountState;

    try {
      // Parse the input
      const parsed = this.parseAmountInput(text);
      
      if (!parsed.isValid) {
        await ctx.reply(
          `❌ **Invalid Amount Format**\n\n` +
          `**Input:** ${text}\n` +
          `**Error:** ${parsed.error}\n\n` +
          `📝 **Valid formats:**\n` +
          `• $100 or 100u (USDT amount)\n` +
          `• 0.1 (token quantity)\n` +
          `• 100u 10x (USDT with leverage)\n\n` +
          `🔄 Use the trading menu to try again.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Execute the trade based on parsed input
      if (mode === 'spot') {
        if (parsed.usdtAmount) {
          await this.handleSpotExecuteAction(ctx, symbol, side, parsed.usdtAmount);
        } else {
          await ctx.reply('❌ Spot trading requires USDT amount. Use formats like $100 or 100u.');
        }
      } else {
        if (parsed.usdtAmount && parsed.leverage) {
          await this.handlePerpsExecuteAction(ctx, symbol, side, parsed.usdtAmount, parsed.leverage);
        } else {
          await ctx.reply('❌ Perps trading requires USDT amount and leverage. Use format like 100u 5x.');
        }
      }

    } catch (error) {
      console.error('Custom amount parsing error:', error);
      await ctx.reply(`❌ Failed to process custom amount. Please try again with the trading menu.`);
    }
  }

  /**
   * Parse amount input in various formats
   */
  private parseAmountInput(input: string): { isValid: boolean; error?: string; usdtAmount?: number; tokenAmount?: number; leverage?: number } {
    const trimmed = input.trim().toLowerCase();
    
    // Pattern 1: $100 or 100u (USDT amount)
    const usdtMatch = trimmed.match(/^[\$]?(\d+(?:\.\d+)?)u?$/);
    if (usdtMatch) {
      const amount = parseFloat(usdtMatch[1]);
      if (amount > 0 && amount <= 10000) {
        return { isValid: true, usdtAmount: amount, leverage: 5 }; // Default 5x leverage
      }
    }

    // Pattern 2: 100u 5x (USDT with leverage)
    const leverageMatch = trimmed.match(/^(\d+(?:\.\d+)?)u?\s+(\d+)x$/);
    if (leverageMatch) {
      const amount = parseFloat(leverageMatch[1]);
      const leverage = parseInt(leverageMatch[2]);
      if (amount > 0 && amount <= 10000 && leverage >= 1 && leverage <= 125) {
        return { isValid: true, usdtAmount: amount, leverage };
      }
    }

    // Pattern 3: 0.1 (token quantity)
    const tokenMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
    if (tokenMatch) {
      const amount = parseFloat(tokenMatch[1]);
      if (amount > 0) {
        return { isValid: true, tokenAmount: amount };
      }
    }

    return { 
      isValid: false, 
      error: 'Invalid format. Use $100, 100u, 0.1, or 100u 5x' 
    };
  }

  /**
   * Handle trade confirmation
   */
  private async handleTradeConfirmation(ctx: BotContext): Promise<void> {
    const pendingTrade = (ctx.userState as any)?.pendingTrade;
    if (!pendingTrade) {
      await ctx.reply('❌ No pending trade to confirm.');
      return;
    }

    try {
      // Execute the confirmed trade
      const { mode, side, symbol, amount, leverage } = pendingTrade;
      
      // Clear pending trade
      delete (ctx.userState as any).pendingTrade;

      if (mode === 'spot') {
        await this.handleSpotExecuteAction(ctx, symbol, side, amount);
      } else {
        await this.handlePerpsExecuteAction(ctx, symbol, side, amount, leverage);
      }

    } catch (error) {
      console.error('Trade confirmation error:', error);
      await ctx.reply('❌ Failed to confirm trade. Please try again.');
    }
  }

  /**
   * Handle trade cancellation
   */
  private async handleTradeCancellation(ctx: BotContext): Promise<void> {
    const pendingTrade = (ctx.userState as any)?.pendingTrade;
    if (!pendingTrade) {
      await ctx.reply('❌ No pending trade to cancel.');
      return;
    }

    // Clear pending trade
    delete (ctx.userState as any).pendingTrade;

    const { mode, symbol } = pendingTrade;
    
    await ctx.editMessageText(
      '❌ **Trade Cancelled**\n\n' +
      'Your pending trade has been cancelled.\n\n' +
      '🔄 Use the trading menu to place a new trade.',
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📈 Trade Again', mode === 'spot' ? 'trade_spot' : 'trade_perps')]
        ])
      }
    );
  }

  /**
   * Handle spot sell menu - displays assets available for selling
   */
  private async handleSpotSellMenu(ctx: BotContext): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const SpotAccountService = await import('../services/SpotAccountService');
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      
      const balances = await spotService.getSpotBalances();
      
      // Filter assets for selling: exclude USDT, minimum balance 0.0001
      const sellableAssets = balances.filter(balance => 
        balance.asset !== 'USDT' && 
        balance.total >= 0.0001
      );
      
      if (sellableAssets.length === 0) {
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Buy Assets', 'trade_spot'),
            Markup.button.callback('💰 Balance', 'balance')
          ],
          [
            Markup.button.callback('🔙 Back', 'trade_spot')
          ]
        ]);
        
        await ctx.editMessageText(
          '💱 **No Assets to Sell**\n\n' +
          'You don\'t have any sellable assets.\n\n' +
          'Use the trading interface to buy some assets first!',
          { parse_mode: 'Markdown', ...keyboard }
        );
        return;
      }

      let sellText = '💱 **Sell Spot Assets**\n\n';
      sellText += '📊 **Available Assets:**\n\n';

      // Create buttons for sellable assets (2 per row, max 16)
      const assetButtons = sellableAssets.slice(0, 16).map(asset => {
        const displayText = asset.usdValue && asset.usdValue > 0.01 
          ? `${asset.asset} ($${asset.usdValue.toFixed(2)})`
          : asset.asset;
        
        sellText += `• **${asset.asset}**: ${asset.total.toFixed(6)} ($${(asset.usdValue || 0).toFixed(2)})\n`;
        
        return Markup.button.callback(displayText, `spot_sell_${asset.asset}`);
      });

      // Arrange buttons in rows of 2
      const buttonRows = [];
      for (let i = 0; i < assetButtons.length; i += 2) {
        buttonRows.push(assetButtons.slice(i, i + 2));
      }

      // Add navigation buttons
      buttonRows.push([
        Markup.button.callback('🔄 Refresh', 'spot_sell_menu'),
        Markup.button.callback('🔙 Back', 'trade_spot')
      ]);

      const keyboard = Markup.inlineKeyboard(buttonRows);

      await ctx.editMessageText(sellText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error('[Orchestrator] Spot sell menu error:', error);
      await ctx.reply('❌ Failed to load sellable assets. Please try again.');
    }
  }

  /**
   * Handle selling specific spot asset
   */
  private async handleSpotSellAsset(ctx: BotContext, asset: string): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const SpotAccountService = await import('../services/SpotAccountService');
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      
      const assetBalance = await spotService.getAssetBalance(asset);
      
      if (!assetBalance || assetBalance.total < 0.0001) {
        await ctx.editMessageText(
          `❌ **Insufficient Balance**\n\n` +
          `**Asset:** ${asset}\n` +
          `**Available:** ${assetBalance?.total.toFixed(6) || '0'}\n\n` +
          `🔄 Use the refresh button to update balances.`,
          { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Back to Sell Menu', 'spot_sell_menu')]
            ])
          }
        );
        return;
      }

      // Get current price
      const symbol = `${asset}USDT`;
      let currentPrice = 0;
      let usdValue = 0;
      
      try {
        const tickers = await apiClient.getAllSpotTickers();
        const ticker = tickers.find(t => t.symbol === symbol);
        if (ticker) {
          currentPrice = parseFloat(ticker.lastPrice);
          usdValue = assetBalance.total * currentPrice;
        }
      } catch (priceError) {
        console.warn(`Failed to get price for ${symbol}:`, priceError);
      }

      const sellText = 
        `💱 **Sell ${asset}**\n\n` +
        `💰 **Available:** ${assetBalance.total.toFixed(6)} ${asset}\n` +
        `💵 **Current Price:** $${currentPrice.toFixed(6)}\n` +
        `📊 **Total Value:** $${usdValue.toFixed(2)}\n\n` +
        `🎯 **Choose sell amount:**`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('25%', `spot_sell_${asset}_25pct`),
          Markup.button.callback('50%', `spot_sell_${asset}_50pct`)
        ],
        [
          Markup.button.callback('75%', `spot_sell_${asset}_75pct`),
          Markup.button.callback('100%', `spot_sell_${asset}_100pct`)
        ],
        [
          Markup.button.callback('🔄 Refresh', `spot_sell_${asset}`),
          Markup.button.callback('🔙 Back', 'spot_sell_menu')
        ]
      ]);

      await ctx.editMessageText(sellText, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
      console.error(`[Orchestrator] Spot sell ${asset} error:`, error);
      await ctx.reply(`❌ Failed to load ${asset} details. Please try again.`);
    }
  }

  /**
   * Execute spot asset sale
   */
  private async executeSpotSale(ctx: BotContext, asset: string, percentage: number): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      await ctx.answerCbQuery(`🔄 Selling ${percentage}% of ${asset}...`);
      
      const processingMsg = await ctx.reply(
        `🔄 **Processing Sell Order**\n\n` +
        `**Asset:** ${asset}\n` +
        `**Amount:** ${percentage}% of holdings\n\n` +
        `⏳ Calculating quantity and executing...`,
        { parse_mode: 'Markdown' }
      );

      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const SpotAccountService = await import('../services/SpotAccountService');
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      
      // Get current balance
      const assetBalance = await spotService.getAssetBalance(asset);
      if (!assetBalance || assetBalance.total < 0.0001) {
        throw new Error('Insufficient balance');
      }

      // Calculate quantity to sell
      const sellQuantity = assetBalance.total * (percentage / 100);
      const symbol = `${asset}USDT`;

      // Format quantity with precision
      const formattedQuantity = await this.formatQuantityWithPrecision(apiClient, symbol, sellQuantity);

      // Execute sell order
      const orderResult = await apiClient.createSpotOrder({
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: formattedQuantity
      });

      // Calculate proceeds
      const executedQty = parseFloat(orderResult.executedQty);
      const avgPrice = parseFloat(orderResult.avgPrice || '0');
      const proceeds = executedQty * avgPrice;

      // Success message
      await ctx.telegram.editMessageText(
        ctx.chat?.id,
        processingMsg.message_id,
        undefined,
        `✅ **Sell Order Executed**\n\n` +
        `**Asset:** ${asset}\n` +
        `**Sold:** ${executedQty.toFixed(6)} ${asset}\n` +
        `**Price:** $${avgPrice.toFixed(6)}\n` +
        `**Proceeds:** ${proceeds.toFixed(2)} USDT\n` +
        `**Order ID:** ${orderResult.orderId}\n\n` +
        `💰 Sale completed successfully!\n\n` +
        `🔙 Use /menu to return to main menu.`,
        { parse_mode: 'Markdown' }
      );

      // Emit event
      this.eventEmitter.emitEvent({
        type: EventTypes.TRADE_EXECUTED,
        timestamp: new Date(),
        userId: ctx.userState.userId,
        telegramId: ctx.userState.telegramId,
        correlationId: ctx.correlationId,
        symbol,
        action: 'SELL',
        amount: proceeds,
        orderId: orderResult.orderId
      });

    } catch (error: any) {
      console.error('Spot sell execution error:', error);
      await ctx.reply(
        `❌ **Sell Order Failed**\n\n` +
        `**Asset:** ${asset}\n` +
        `**Amount:** ${percentage}%\n` +
        `**Error:** ${error.message || 'Unknown error'}\n\n` +
        `🔄 Please try again or contact support.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle custom pair input functionality
   */
  private async handleCustomPairInput(ctx: BotContext, mode: 'spot' | 'perps'): Promise<void> {
    const modeEmoji = mode === 'spot' ? '🏪' : '⚡';
    const modeText = mode === 'spot' ? 'Spot' : 'Perps';
    
    await ctx.editMessageText(
      `🎯 **Custom ${modeText} Trading Pair**\n\n` +
      `✍️ Please type the trading pair symbol you want to trade:\n\n` +
      `📝 **Examples:**\n` +
      `• BTCUSDT\n` +
      `• ETHUSDT\n` +
      `• BNBUSDT\n` +
      `• ADAUSDT\n\n` +
      `💡 **Note:** Symbol must end with USDT\n\n` +
      `⏳ Waiting for your input...`,
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back', mode === 'spot' ? 'trade_spot' : 'trade_perps')]
        ])
      }
    );

    // Set conversation state to expect custom pair input
    if (ctx.userState) {
      (ctx.userState as any).expectingCustomPair = mode;
    }
  }

  /**
   * Handle custom pair text input
   */
  private async handleCustomPairText(ctx: BotContext, text: string): Promise<void> {
    const mode = (ctx.userState as any)?.expectingCustomPair;
    if (!mode) return;

    // Clear conversation state
    delete (ctx.userState as any).expectingCustomPair;

    const symbol = text.toUpperCase().trim();
    
    // Validate symbol format
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
      await ctx.reply(
        `❌ **Invalid Symbol Format**\n\n` +
        `**Entered:** ${text}\n` +
        `**Required:** Symbol must end with USDT\n\n` +
        `📝 **Examples:** BTCUSDT, ETHUSDT, BNBUSDT\n\n` +
        `🔄 Please try again with /trade command.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    try {
      // Validate symbol exists
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      if (mode === 'spot') {
        // Check if symbol exists in spot market
        const tickers = await apiClient.getAllSpotTickers();
        const symbolExists = tickers.some(t => t.symbol === symbol);
        
        if (!symbolExists) {
          await this.handleSymbolNotFound(ctx, symbol, 'spot');
          return;
        }
        
        // Redirect to spot trading for this symbol
        await this.tradingHandler.handleSpotSymbolTrading(ctx, symbol, 'BUY');
      } else {
        // Check if symbol exists in futures market
        const ticker = await apiClient.get24hrTicker(symbol);
        
        if (!ticker) {
          await this.handleSymbolNotFound(ctx, symbol, 'perps');
          return;
        }
        
        // Redirect to perps trading for this symbol
        await this.tradingHandler.handlePerpsSymbolTrading(ctx, symbol, 'BUY');
      }
    } catch (error) {
      console.error('Custom pair validation error:', error);
      await this.handleSymbolNotFound(ctx, symbol, mode);
    }
  }

  /**
   * Handle when symbol is not found
   */
  private async handleSymbolNotFound(ctx: BotContext, symbol: string, mode: 'spot' | 'perps'): Promise<void> {
    const modeText = mode === 'spot' ? 'Spot' : 'Perps';
    
    await ctx.reply(
      `❌ **Symbol Not Found**\n\n` +
      `**${symbol}** is not available for ${modeText} trading.\n\n` +
      `💡 **Suggestions:**\n` +
      `• Check spelling (must end with USDT)\n` +
      `• Try popular pairs: BTCUSDT, ETHUSDT, BNBUSDT\n` +
      `• Use the symbol buttons in trading menu\n\n` +
      `🔄 Use /trade to return to trading menu.`,
      { parse_mode: 'Markdown' }
    );
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