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
    // Start command
    this.bot.command('start', (ctx) => 
      this.navigationHandler.showMainMenu(ctx)
    );

    // Menu command
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
      this.server.listen(port, () => {
        console.log(`[Server] Listening on port ${port}`);
      });

      // Start bot
      await this.bot.launch();
      
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

    this.bot.stop();
    await this.db.disconnect();
    
    console.log('Bot stopped gracefully');
    process.exit(0);
  }
}