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

    // Trade command
    this.bot.command('trade', (ctx) => 
      this.navigationHandler.showTradingMenu(ctx)
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
      this.handlePlaceholderAction(ctx, '💰 Balance feature coming soon!')
    );

    this.bot.action('positions', (ctx) => 
      this.handlePlaceholderAction(ctx, '📊 Positions feature coming soon!')
    );

    this.bot.action('settings', (ctx) => 
      this.handlePlaceholderAction(ctx, '⚙️ Settings feature coming soon!')
    );

    this.bot.action('help', (ctx) => 
      this.handlePlaceholderAction(ctx, '📖 Help feature coming soon!')
    );

    this.bot.action('link_api', (ctx) => 
      this.handlePlaceholderAction(ctx, '🔗 API linking feature coming soon!')
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
      const action = side === 'BUY' ? 'Buy' : 'Sell';
      const emoji = side === 'BUY' ? '🟢' : '🔴';
      
      await ctx.answerCbQuery(`${emoji} ${action} ${symbol} $${amount} - Coming soon!`);
      await ctx.reply(
        `${emoji} **Spot ${action} Order**\n\n` +
        `**Symbol:** ${symbol}\n` +
        `**Amount:** $${amount}\n` +
        `**Type:** ${action}\n\n` +
        `🚧 Trade execution feature coming soon!\n\n` +
        `🔙 Use /menu to return to main menu.`,
        { parse_mode: 'Markdown' }
      );
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
      const action = side === 'BUY' ? 'Long' : 'Short';
      const emoji = side === 'BUY' ? '📈' : '📉';
      
      await ctx.answerCbQuery(`${emoji} ${action} ${symbol} $${amount} ${leverage}x - Coming soon!`);
      await ctx.reply(
        `${emoji} **Perps ${action} Order**\n\n` +
        `**Symbol:** ${symbol}\n` +
        `**Amount:** $${amount}\n` +
        `**Leverage:** ${leverage}x\n` +
        `**Type:** ${action}\n\n` +
        `🚧 Trade execution feature coming soon!\n\n` +
        `🔙 Use /menu to return to main menu.`,
        { parse_mode: 'Markdown' }
      );
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