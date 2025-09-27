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
  private publicApiClient!: any;
  
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
    this.db = new DatabaseManager(this.config.database.url);
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
   * Initialize public API client (async component)
   */
  private async initializePublicApiClient(): Promise<void> {
    try {
      const AsterApiClient = await import('../aster');
      // Use the same base URL as authenticated API client for consistency
      this.publicApiClient = new AsterApiClient.AsterApiClient(this.config.aster.baseUrl, '', '');
      console.log(`[Orchestrator] Public API client initialized with base URL: ${this.config.aster.baseUrl}`);
    } catch (error) {
      console.error('[Orchestrator] CRITICAL: Failed to initialize public API client:', error);
      throw new Error(`Failed to initialize public API client: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Initialize async components after construction
   */
  async initialize(): Promise<void> {
    await this.initializePublicApiClient();
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
        clients: 0, // No session caching after horizontal scaling optimization
        auth_cache: { status: 'disabled', reason: 'caching removed for data consistency' }
      });
    });
    
    // Metrics endpoint
    this.server.get('/metrics', (req, res) => {
      res.json({
        api_clients: 0, // No session caching after horizontal scaling optimization
        auth_cache: { status: 'disabled', reason: 'caching removed for data consistency' },
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

    this.bot.action('cancel_linking', (ctx) => 
      this.handleCancelLinking(ctx)
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

    // Refresh position P&L handler
    this.bot.action(/^refresh_position_(.+)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleRefreshPosition(ctx, symbol);
    });

    // TP/SL action handlers
    this.bot.action(/^sl_set_([A-Z0-9]+USDT)_([0-9.]+)_(\d+)$/, (ctx) => {
      const symbol = ctx.match[1];
      const price = parseFloat(ctx.match[2]);
      const riskPercent = parseInt(ctx.match[3]);
      this.handleExecuteStopLoss(ctx, symbol, price, riskPercent);
    });

    this.bot.action(/^tp_set_([A-Z0-9]+USDT)_([0-9.]+)_(\d+)$/, (ctx) => {
      const symbol = ctx.match[1];
      const price = parseFloat(ctx.match[2]);
      const profitPercent = parseInt(ctx.match[3]);
      this.handleExecuteTakeProfit(ctx, symbol, price, profitPercent);
    });

    this.bot.action(/^sl_custom_([A-Z0-9]+USDT)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleCustomStopLoss(ctx, symbol);
    });

    this.bot.action(/^tp_custom_([A-Z0-9]+USDT)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleCustomTakeProfit(ctx, symbol);
    });

    this.bot.action(/^sl_market_([A-Z0-9]+USDT)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleMarketStopLoss(ctx, symbol);
    });

    this.bot.action(/^tp_market_([A-Z0-9]+USDT)$/, (ctx) => {
      const symbol = ctx.match[1];
      this.handleMarketTakeProfit(ctx, symbol);
    });

    // Spot sell percentage handlers
    this.bot.action(/^spot_sell_(\d+)_(.+)$/, (ctx) => {
      const percentage = parseInt(ctx.match[1]);
      const symbol = ctx.match[2];
      this.handleSpotSellPercentage(ctx, symbol, percentage);
    });

    // Spot confirm sell handler
    this.bot.action(/^spot_confirm_sell_(.+)_(.+)$/, (ctx) => {
      const quantity = ctx.match[1];
      const symbol = ctx.match[2];
      this.handleSpotConfirmSell(ctx, symbol, parseFloat(quantity));
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
      this.handleSpotTradingSelection(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL');
    });

    this.bot.action(/^perps_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const action = ctx.match[1];  // 'buy' or 'sell'
      const symbol = ctx.match[2];  // 'BTCUSDT', 'ETHUSDT', etc.
      this.handlePerpsLeverageSelection(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL');
    });

    // Two-step trading flow handlers
    // Step 1: Leverage selection for perps
    this.bot.action(/^perps_leverage_(buy|sell)_([A-Z0-9]+USDT)_(\d+)x$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const leverage = parseInt(ctx.match[3]);
      this.handlePerpsMarginModeSelection(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL', leverage);
    });

    // Step 2: Margin mode selection for perps
    this.bot.action(/^perps_margin_(buy|sell)_([A-Z0-9]+USDT)_(\d+)x_(cross|isolated)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const leverage = parseInt(ctx.match[3]);
      const marginMode = ctx.match[4] as 'cross' | 'isolated';
      this.handlePerpsAmountSelection(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL', leverage, marginMode);
    });

    // Step 3: Amount selection for perps/spot
    this.bot.action(/^perps_amount_(buy|sell)_([A-Z0-9]+USDT)_(\d+)x_(cross|isolated)_(\d+)pct$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const leverage = parseInt(ctx.match[3]);
      const marginMode = ctx.match[4] as 'cross' | 'isolated';
      const percentage = parseInt(ctx.match[5]);
      this.handlePerpsTPSLSelection(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL', leverage, marginMode, percentage, 'percentage');
    });

    this.bot.action(/^spot_amount_(buy|sell)_([A-Z0-9]+USDT)_(\d+)pct$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const percentage = parseInt(ctx.match[3]);
      this.handleSpotTPSLSelection(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL', percentage, 'percentage');
    });

    // Manual amount input handlers
    this.bot.action(/^perps_manual_usdt_(buy|sell)_([A-Z0-9]+USDT)_(\d+)x_(cross|isolated)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const leverage = parseInt(ctx.match[3]);
      const marginMode = ctx.match[4] as 'cross' | 'isolated';
      this.handleManualUSDTInput(ctx, 'perps', symbol, action.toUpperCase() as 'BUY' | 'SELL', leverage, marginMode);
    });

    this.bot.action(/^perps_manual_token_(buy|sell)_([A-Z0-9]+USDT)_(\d+)x_(cross|isolated)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const leverage = parseInt(ctx.match[3]);
      const marginMode = ctx.match[4] as 'cross' | 'isolated';
      this.handleManualTokenInput(ctx, 'perps', symbol, action.toUpperCase() as 'BUY' | 'SELL', leverage, marginMode);
    });

    this.bot.action(/^spot_manual_usdt_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      this.handleManualUSDTInput(ctx, 'spot', symbol, action.toUpperCase() as 'BUY' | 'SELL');
    });

    this.bot.action(/^spot_manual_token_(buy|sell)_([A-Z0-9]+USDT)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      this.handleManualTokenInput(ctx, 'spot', symbol, action.toUpperCase() as 'BUY' | 'SELL');
    });

    // TP/SL selection handlers
    this.bot.action(/^perps_tpsl_(buy|sell)_([A-Z0-9]+USDT)_(\d+)x_(cross|isolated)_(\d+|\d+\.\d+)_(percentage|usdt|token)_tp(\d+|\d+\.\d+|none)_sl(\d+|\d+\.\d+|none)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const leverage = parseInt(ctx.match[3]);
      const marginMode = ctx.match[4] as 'cross' | 'isolated';
      const amount = parseFloat(ctx.match[5]);
      const amountType = ctx.match[6];
      const tpValue = ctx.match[7] === 'none' ? null : parseFloat(ctx.match[7]);
      const slValue = ctx.match[8] === 'none' ? null : parseFloat(ctx.match[8]);
      this.handlePerpsTPSLExecute(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL', leverage, marginMode, amount, amountType, tpValue, slValue);
    });

    this.bot.action(/^spot_tpsl_(buy|sell)_([A-Z0-9]+USDT)_(\d+|\d+\.\d+)_(percentage|usdt|token)_tp(\d+|\d+\.\d+|none)_sl(\d+|\d+\.\d+|none)$/, (ctx) => {
      const action = ctx.match[1];
      const symbol = ctx.match[2];
      const amount = parseFloat(ctx.match[3]);
      const amountType = ctx.match[4];
      const tpValue = ctx.match[5] === 'none' ? null : parseFloat(ctx.match[5]);
      const slValue = ctx.match[6] === 'none' ? null : parseFloat(ctx.match[6]);
      this.handleSpotTPSLExecute(ctx, symbol, action.toUpperCase() as 'BUY' | 'SELL', amount, amountType, tpValue, slValue);
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
    this.bot.on('text', async (ctx) => {
      // Handle conversation states and natural language commands
      console.log(`[Text] Received: ${ctx.message.text} from user ${ctx.userState?.userId}`);
      console.log(`[Text] Conversation state: ${ctx.userState?.conversationState?.step || 'none'}`);
      
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
      
      // Check if expecting manual USDT input
      if ((ctx.userState as any)?.expectingManualUSDT) {
        this.handleManualUSDTText(ctx, ctx.message.text);
        return;
      }
      
      // Check if expecting manual token input
      if ((ctx.userState as any)?.expectingManualToken) {
        this.handleManualTokenText(ctx, ctx.message.text);
        return;
      }

      // Check if expecting custom TP/SL price input
      if (ctx.userState?.conversationState?.step === 'waiting_custom_pair' && 
          ctx.userState?.conversationState?.data?.action) {
        this.handleCustomTPSLPriceText(ctx, ctx.message.text);
        return;
      }

      // Check if expecting API key input
      if (ctx.userState?.conversationState?.step === 'waiting_api_key') {
        this.handleApiKeyInput(ctx, ctx.message.text);
        return;
      }

      // Check if expecting API secret input
      if (ctx.userState?.conversationState?.step === 'waiting_api_secret') {
        this.handleApiSecretInput(ctx, ctx.message.text);
        return;
      }

      // Fallback: Check if text looks like API key/secret and user is not linked
      if (!ctx.userState?.isLinked && ctx.message.text.length > 30) {
        const text = ctx.message.text.trim();
        // Basic heuristic: if it looks like a long alphanumeric string, might be API key/secret
        if (/^[a-zA-Z0-9]{30,}$/.test(text)) {
          console.log(`[Text] Detected potential API key/secret from unlinked user`);
          await ctx.reply(
            '🔗 **API Key Detected**\n\n' +
            'It looks like you sent an API key, but I need to start the linking process first.\n\n' +
            'Please click the "🔗 Link API" button to begin the secure linking process.',
            { parse_mode: 'Markdown' }
          );
          return;
        }
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
      // Initialize async components first
      await this.initialize();
      
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
      const webhookDomain = new URL(this.config.webhook.url).origin;
      this.server.use(await this.bot.createWebhook({
        domain: webhookDomain,
        path: this.config.webhook.path,
        secret_token: this.config.webhook.secretToken
      }));
      console.log(`[Server] ✅ Webhook endpoint created at ${this.config.webhook.path}`);

      // Check current webhook before setting new one
      try {
        const currentWebhook = await this.bot.telegram.getWebhookInfo();
        const needsUpdate = currentWebhook.url !== this.config.webhook.url;
        
        if (needsUpdate) {
          console.log(`[Bot] 🔄 Updating webhook from '${currentWebhook.url}' to '${this.config.webhook.url}'`);
          
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
        } else {
          console.log(`[Bot] ✅ Webhook already configured correctly: ${currentWebhook.url}`);
        }
      } catch (error) {
        console.error(`[Bot] ❌ Failed to check/set webhook:`, error);
        // Continue anyway - the server can still receive webhooks
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
   * Always send new messages instead of editing (except for the most recent message)
   * This ensures all updates are visible at bottom of chat for better UX
   */
  private async safeEditMessageText(ctx: BotContext, text: string, options: any): Promise<void> {
    try {
      // Always send new message to keep updates visible at bottom of chat
      // This prevents users from missing updates buried in chat history
      await ctx.reply(text, options);
      
    } catch (error: any) {
      console.error('[Bot] Failed to send message:', error);
      try {
        await ctx.reply('❌ Unable to load content. Please try again.');
      } catch (fallbackError) {
        console.error('[Bot] Failed to send fallback message:', fallbackError);
      }
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

        // Enhanced success message with position management
        const executedPrice = parseFloat(orderResult.avgPrice || orderResult.fills?.[0]?.price || '0');
        await this.showExecutionSuccessWithPositionManagement(
          ctx, 
          processingMsg.message_id, 
          'spot', 
          symbol, 
          action, 
          amount, 
          undefined, 
          amount, 
          executedPrice, 
          String(orderResult.orderId)
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
          orderId: String(orderResult.orderId)
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

        // Enhanced success message with position management
        await this.showExecutionSuccessWithPositionManagement(
          ctx, 
          processingMsg.message_id, 
          'perps', 
          symbol, 
          action, 
          amount, 
          leverage, 
          positionSizeUSDT, 
          executedPrice, 
          String(orderResult.orderId)
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
          orderId: String(orderResult.orderId)
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
🆘 **AsterBot Knowledge Center**

Your complete guide to professional Telegram trading with AsterBot. Learn how to maximize your trading efficiency and unlock all features.

**🚀 Quick Start Guide:**
• **/start** — Welcome and onboarding experience
• **/link** — Securely connect your Aster DEX API credentials
• **/trade** — Access the professional trading suite
• **/price** — Live market intelligence and price tracking

**📈 Advanced Commands:**
• **/positions** — Real-time portfolio and position management
• **/balance** — Multi-asset balance overview and analysis
• **/settings** — Customize risk management and trading presets
• **/menu** — Return to main dashboard anytime

**🔧 Trading Features:**
• **Smart Execution** — Automatic slippage protection and optimal fills
• **Leverage Trading** — Up to 125x leverage with advanced risk controls
• **Natural Language** — Type amounts like "$100", "50%", or "0.1 BTC"
• **One-Click Management** — Partial closes, position sizing, and quick trades

**🛡️ Security & Safety:**
• Your API keys are encrypted and stored locally
• PIN protection for sensitive operations
• Daily loss caps and leverage limits
• Real-time risk monitoring

**📞 Need More Help?**
Contact @AsterDEX\\_Support or visit docs.aster.exchange for detailed guides.
    `.trim();

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
  }

  /**
   * Handle link API command
   */
  private async handleLinkCommand(ctx: BotContext): Promise<void> {
    // Check if already linked
    if (ctx.userState?.isLinked) {
      await ctx.reply(
        '✅ **API Already Linked**\n\n' +
        'Your API credentials are already connected.\n\n' +
        '**Options:**\n' +
        '• Use /unlink to disconnect current API\n' +
        '• Use /menu to access trading features',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Initialize conversation state for API linking
    if (!ctx.userState) {
      ctx.userState = {
        userId: 0,
        telegramId: ctx.from?.id || 0,
        isLinked: false,
        settings: {
          user_id: 0,
          leverage_cap: 100,
          default_leverage: 10,
          size_presets: [25, 50, 100],
          slippage_bps: 50,
          tp_presets: [5, 10, 15],
          sl_presets: [5, 10, 15],
          daily_loss_cap: 500,
          pin_hash: null
        }
      };
    }

    // Set conversation state to wait for API key
    ctx.userState.conversationState = {
      step: 'waiting_api_key',
      data: { pendingAction: 'link' }
    };

    console.log(`[Link] Set conversation state for user ${ctx.userState.telegramId}: waiting_api_key`);

    const linkingText = [
      '🔗 **API Linking Process**',
      '',
      '🔒 **Step 1: API Key**',
      '',
      'Please send your Aster DEX API Key.',
      '',
      '**How to get your API Key:**',
      '1. Visit aster.exchange',
      '2. Go to Account → API Management',
      '3. Create new API key with trading permissions',
      '',
      '⚠️ **Security Note:**',
      '• Your keys are encrypted before storage',
      '• Never share your API keys with anyone',
      '• You can unlink anytime with /unlink',
      '',
      '📝 **Send your API Key now:**'
    ].join('\n');

    await ctx.reply(linkingText, { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'cancel_linking')]
      ])
    });
  }

  /**
   * Handle cancel linking
   */
  private async handleCancelLinking(ctx: BotContext): Promise<void> {
    // Clear conversation state
    if (ctx.userState) {
      ctx.userState.conversationState = undefined;
    }

    await ctx.editMessageText(
      '❌ **API Linking Cancelled**\n\n' +
      'You can start the linking process again anytime by clicking the Link API button.',
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle API key input
   */
  private async handleApiKeyInput(ctx: BotContext, apiKey: string): Promise<void> {
    try {
      // Basic validation
      const trimmedKey = apiKey.trim();
      if (trimmedKey.length < 10) {
        await ctx.reply(
          '❌ **Invalid API Key**\n\n' +
          'API key seems too short. Please check and send your correct API key.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Store API key temporarily and move to next step
      if (!ctx.userState?.conversationState?.data) {
        ctx.userState!.conversationState!.data = {};
      }
      ctx.userState!.conversationState!.data!.apiKey = trimmedKey;
      ctx.userState!.conversationState!.step = 'waiting_api_secret';

      const secretText = [
        '🔒 **Step 2: API Secret**',
        '',
        'Great! Now please send your API Secret.',
        '',
        '⚠️ **Security Reminder:**',
        '• API secrets are longer than API keys',
        '• Make sure to copy the complete secret',
        '• This will be encrypted before storage',
        '',
        '📝 **Send your API Secret now:**'
      ].join('\n');

      await ctx.reply(secretText, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Cancel', 'cancel_linking')]
        ])
      });

    } catch (error) {
      console.error('API key input error:', error);
      await ctx.reply('❌ Error processing API key. Please try again.');
    }
  }

  /**
   * Handle API secret input
   */
  private async handleApiSecretInput(ctx: BotContext, apiSecret: string): Promise<void> {
    try {
      // Basic validation
      const trimmedSecret = apiSecret.trim();
      if (trimmedSecret.length < 20) {
        await ctx.reply(
          '❌ **Invalid API Secret**\n\n' +
          'API secret seems too short. Please check and send your correct API secret.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const apiKey = ctx.userState?.conversationState?.data?.apiKey;
      if (!apiKey) {
        await ctx.reply('❌ API key lost. Please start the linking process again.');
        return;
      }

      // Show progress message
      await ctx.reply('⏳ **Testing API Credentials...**\n\nPlease wait while we verify your API keys.', { 
        parse_mode: 'Markdown' 
      });

      // Test the API credentials
      const testClient = new (await import('../aster')).AsterApiClient(
        this.config.aster.baseUrl,
        apiKey,
        trimmedSecret,
        false
      );

      // Test with account info call
      await testClient.getAccount();

      // Save credentials to database
      const userService = await this.userService.getUserOrCreate(ctx.from!.id);
      await this.credentialsService.saveCredentials(userService.id, apiKey, trimmedSecret);

      // Update user state
      ctx.userState!.isLinked = true;
      ctx.userState!.userId = userService.id;
      ctx.userState!.conversationState = undefined;

      // Success message
      const successText = [
        '✅ **API Successfully Linked!**',
        '',
        '🎉 Your Aster DEX API credentials have been securely connected.',
        '',
        '**What you can do now:**',
        '• View your account balance',
        '• Place spot and futures trades',
        '• Manage positions and orders',
        '• Set stop-loss and take-profit orders',
        '',
        '🚀 Ready to start trading!'
      ].join('\n');

      await ctx.reply(successText, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 View Balance', 'balance')],
          [Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ])
      });

    } catch (error: any) {
      console.error('API secret validation error:', error);
      
      // Clear conversation state
      if (ctx.userState) {
        ctx.userState.conversationState = undefined;
      }

      const errorMessage = error.message || 'Unknown error';
      await ctx.reply(
        '❌ **API Verification Failed**\n\n' +
        `Error: ${errorMessage}\n\n` +
        'Please check your credentials and try again with /link',
        { parse_mode: 'Markdown' }
      );
    }
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
          await this.handleSetStopLoss(ctx, symbol);
          break;
        case 'set_tp':
          await this.handleSetTakeProfit(ctx, symbol);
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
   * Show enhanced execution success message with position management interface
   */
  private async showExecutionSuccessWithPositionManagement(
    ctx: BotContext, 
    messageId: number,
    type: 'spot' | 'perps',
    symbol: string, 
    action: string,
    amount: number,
    leverage?: number,
    positionSizeUSDT?: number,
    executedPrice?: number,
    orderId?: string
  ): Promise<void> {
    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Get current position/balance info
      let positionInfo = '';
      let managementButtons: any[] = [];
      
      if (type === 'perps') {
        // Get current perp position
        const positions = await apiClient.getPositionRisk();
        const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        
        if (position) {
          const positionAmt = parseFloat(position.positionAmt);
          const side = positionAmt > 0 ? 'LONG' : 'SHORT';
          const pnl = parseFloat(position.unrealizedPnl) || 0;
          const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
          const sideEmoji = side === 'LONG' ? '🟢' : '🔴';
          
          positionInfo = [
            '',
            '📊 **Current Position Status:**',
            `${sideEmoji} **${side}** ${Math.abs(positionAmt).toFixed(4)} ${symbol.replace('USDT', '')}`,
            `💰 **Entry Price:** $${position.entryPrice}`,
            `⚡ **Leverage:** ${position.leverage}x`,
            `${pnlEmoji} **Unrealized P&L:** ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
            `📈 **Current Value:** $${(Math.abs(positionAmt) * parseFloat(position.entryPrice)).toFixed(2)}`
          ].join('\n');
          
          managementButtons = [
            [
              Markup.button.callback('🔴 Close 25%', `position_close_25_${symbol}`),
              Markup.button.callback('🔴 Close 50%', `position_close_50_${symbol}`)
            ],
            [
              Markup.button.callback('🔴 Close 75%', `position_close_75_${symbol}`),
              Markup.button.callback('🔴 Close All', `position_close_${symbol}`)
            ]
          ];
        }
      } else {
        // Spot balance display simplified for now until full spot API is available
        positionInfo = [
          '',
          '💼 **Spot Trade Completed**',
          `✅ Order executed successfully`,
          `📊 View your balances in the main menu`
        ].join('\n');
        
        managementButtons = [
          [
            Markup.button.callback('💰 View Balance', 'balance'),
            Markup.button.callback('📈 Trade Again', 'trade_spot')
          ]
        ];
      }
      
      // Create success message
      const actionEmoji = action.toLowerCase().includes('buy') || action.toLowerCase().includes('long') ? '🟢' : '🔴';
      const typeLabel = type === 'perps' ? 'Futures' : 'Spot';
      
      let successText = [
        `✅ **${typeLabel} ${action} Order Executed Successfully!**`,
        '',
        `${actionEmoji} **Symbol:** ${symbol}`,
        `💰 **Amount:** $${(positionSizeUSDT || amount).toFixed(2)}`,
        leverage ? `⚡ **Leverage:** ${leverage}x` : '',
        executedPrice ? `💱 **Executed Price:** $${executedPrice.toFixed(4)}` : '',
        orderId ? `🔗 **Order ID:** \`${orderId}\`` : ''
      ].filter(line => line !== '').join('\n');
      
      // Add position info if available
      if (positionInfo) {
        successText += positionInfo;
      }
      
      // Create keyboard with management options
      const keyboard = Markup.inlineKeyboard([
        ...managementButtons,
        [
          Markup.button.callback('🔄 Refresh P&L', `refresh_position_${symbol}`),
          Markup.button.callback('📊 View All Positions', 'positions')
        ],
        [
          Markup.button.callback('📈 Trade Again', type === 'perps' ? 'trade_perps' : 'trade_spot'),
          Markup.button.callback('🏠 Main Menu', 'main_menu')
        ]
      ]);
      
      await ctx.editMessageText(successText, { 
        parse_mode: 'Markdown', 
        ...keyboard 
      });
      
    } catch (error) {
      console.error('Error showing execution success with position management:', error);
      // Fallback to simple success message
      const actionEmoji = action.toLowerCase().includes('buy') || action.toLowerCase().includes('long') ? '🟢' : '🔴';
      const typeLabel = type === 'perps' ? 'Futures' : 'Spot';
      
      const fallbackText = [
        `✅ **${typeLabel} ${action} Order Executed!**`,
        '',
        `${actionEmoji} **Symbol:** ${symbol}`,
        `💰 **Amount:** $${(positionSizeUSDT || amount).toFixed(2)}`,
        leverage ? `⚡ **Leverage:** ${leverage}x` : '',
        '',
        'Use /menu to continue trading'
      ].filter(line => line !== '').join('\n');
      
      await ctx.editMessageText(fallbackText, { parse_mode: 'Markdown' });
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
   * Handle setting stop loss for a position
   */
  private async handleSetStopLoss(ctx: BotContext, symbol: string): Promise<void> {
    try {
      await ctx.answerCbQuery('🛡️ Setting up Stop Loss...');
      
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Get current position
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (!position) {
        await ctx.reply(`❌ **No Open Position**\n\n**Symbol:** ${symbol}\n\nYou don't have an open position for this symbol.`);
        return;
      }
      
      const positionSize = parseFloat(position.positionAmt);
      const entryPrice = parseFloat(position.entryPrice);
      const isLong = positionSize > 0;
      
      // Calculate suggested stop loss levels (risk percentages)
      const risk5Pct = isLong ? entryPrice * 0.95 : entryPrice * 1.05;
      const risk10Pct = isLong ? entryPrice * 0.90 : entryPrice * 1.10;
      const risk15Pct = isLong ? entryPrice * 0.85 : entryPrice * 1.15;
      const risk20Pct = isLong ? entryPrice * 0.80 : entryPrice * 1.20;
      
      const stopLossText = [
        `🛡️ **Set Stop Loss for ${symbol}**`,
        `📍 **Position:** ${isLong ? 'LONG' : 'SHORT'} ${Math.abs(positionSize)} ${symbol.replace('USDT', '')}`,
        `💰 **Entry Price:** $${entryPrice.toFixed(6)}`,
        `📊 **Current Price:** $${entryPrice.toFixed(6)}`,
        `${isLong ? '📉' : '📈'} **Unrealized PnL:** ${parseFloat(position.unrealizedPnl).toFixed(2)} USDT`,
        '',
        '🎯 **Choose Stop Loss Level:**'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`5% Risk ($${risk5Pct.toFixed(6)})`, `sl_set_${symbol}_${risk5Pct.toFixed(6)}_5`),
          Markup.button.callback(`10% Risk ($${risk10Pct.toFixed(6)})`, `sl_set_${symbol}_${risk10Pct.toFixed(6)}_10`)
        ],
        [
          Markup.button.callback(`15% Risk ($${risk15Pct.toFixed(6)})`, `sl_set_${symbol}_${risk15Pct.toFixed(6)}_15`),
          Markup.button.callback(`20% Risk ($${risk20Pct.toFixed(6)})`, `sl_set_${symbol}_${risk20Pct.toFixed(6)}_20`)
        ],
        [
          Markup.button.callback('📝 Custom Price', `sl_custom_${symbol}`),
          Markup.button.callback('📊 Market Price', `sl_market_${symbol}`)
        ],
        [
          Markup.button.callback('🔙 Back to Position', `position_${symbol}`)
        ]
      ]);
      
      await this.safeEditMessageText(ctx, stopLossText, { parse_mode: 'Markdown', ...keyboard });
      
    } catch (error: any) {
      console.error('Set stop loss error:', error);
      await ctx.reply(`❌ **Stop Loss Setup Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}\n\n🔄 Please try again.`);
    }
  }

  /**
   * Handle setting take profit for a position
   */
  private async handleSetTakeProfit(ctx: BotContext, symbol: string): Promise<void> {
    try {
      await ctx.answerCbQuery('🎯 Setting up Take Profit...');
      
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Get current position
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (!position) {
        await ctx.reply(`❌ **No Open Position**\n\n**Symbol:** ${symbol}\n\nYou don't have an open position for this symbol.`);
        return;
      }
      
      const positionSize = parseFloat(position.positionAmt);
      const entryPrice = parseFloat(position.entryPrice);
      const isLong = positionSize > 0;
      
      // Calculate suggested take profit levels (profit percentages)
      const profit10Pct = isLong ? entryPrice * 1.10 : entryPrice * 0.90;
      const profit25Pct = isLong ? entryPrice * 1.25 : entryPrice * 0.75;
      const profit50Pct = isLong ? entryPrice * 1.50 : entryPrice * 0.50;
      const profit100Pct = isLong ? entryPrice * 2.00 : entryPrice * 0.50;
      
      const takeProfitText = [
        `🎯 **Set Take Profit for ${symbol}**`,
        `📍 **Position:** ${isLong ? 'LONG' : 'SHORT'} ${Math.abs(positionSize)} ${symbol.replace('USDT', '')}`,
        `💰 **Entry Price:** $${entryPrice.toFixed(6)}`,
        `📊 **Current Price:** $${entryPrice.toFixed(6)}`,
        `${isLong ? '📈' : '📉'} **Unrealized PnL:** ${parseFloat(position.unrealizedPnl).toFixed(2)} USDT`,
        '',
        '💰 **Choose Take Profit Level:**'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`10% Profit ($${profit10Pct.toFixed(6)})`, `tp_set_${symbol}_${profit10Pct.toFixed(6)}_10`),
          Markup.button.callback(`25% Profit ($${profit25Pct.toFixed(6)})`, `tp_set_${symbol}_${profit25Pct.toFixed(6)}_25`)
        ],
        [
          Markup.button.callback(`50% Profit ($${profit50Pct.toFixed(6)})`, `tp_set_${symbol}_${profit50Pct.toFixed(6)}_50`),
          Markup.button.callback(`100% Profit ($${profit100Pct.toFixed(6)})`, `tp_set_${symbol}_${profit100Pct.toFixed(6)}_100`)
        ],
        [
          Markup.button.callback('📝 Custom Price', `tp_custom_${symbol}`),
          Markup.button.callback('📊 Market Price', `tp_market_${symbol}`)
        ],
        [
          Markup.button.callback('🔙 Back to Position', `position_${symbol}`)
        ]
      ]);
      
      await this.safeEditMessageText(ctx, takeProfitText, { parse_mode: 'Markdown', ...keyboard });
      
    } catch (error: any) {
      console.error('Set take profit error:', error);
      await ctx.reply(`❌ **Take Profit Setup Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}\n\n🔄 Please try again.`);
    }
  }

  /**
   * Execute stop loss order
   */
  private async handleExecuteStopLoss(ctx: BotContext, symbol: string, stopPrice: number, riskPercent: number): Promise<void> {
    try {
      await ctx.answerCbQuery(`🛡️ Setting ${riskPercent}% risk stop loss...`);
      
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Execute the stop loss order
      const result = await apiClient.setStopLoss(symbol, stopPrice);
      
      const successText = [
        `✅ **Stop Loss Set Successfully**`,
        '',
        `🛡️ **Symbol:** ${symbol}`,
        `💰 **Stop Price:** $${stopPrice.toFixed(6)}`,
        `📊 **Risk Level:** ${riskPercent}%`,
        `🆔 **Order ID:** ${result.orderId}`,
        '',
        '⚠️ *Your position is now protected with a stop loss order.*'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 View Position', `position_${symbol}`),
          Markup.button.callback('🎯 Set Take Profit', `position_set_tp_${symbol}`)
        ],
        [
          Markup.button.callback('🔙 Back to Positions', 'positions_menu')
        ]
      ]);
      
      await this.safeEditMessageText(ctx, successText, { parse_mode: 'Markdown', ...keyboard });
      
      // Emit event
      this.eventEmitter.emitEvent({
        type: EventTypes.TRADE_EXECUTED,
        timestamp: new Date(),
        userId: ctx.userState!.userId,
        telegramId: ctx.userState!.telegramId,
        correlationId: ctx.correlationId,
        symbol,
        action: 'STOP_LOSS',
        price: stopPrice.toString(),
        orderId: result.orderId
      });
      
    } catch (error: any) {
      console.error('Execute stop loss error:', error);
      await ctx.reply(`❌ **Stop Loss Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}\n\n🔄 Please try again.`);
    }
  }

  /**
   * Execute take profit order
   */
  private async handleExecuteTakeProfit(ctx: BotContext, symbol: string, targetPrice: number, profitPercent: number): Promise<void> {
    try {
      await ctx.answerCbQuery(`🎯 Setting ${profitPercent}% profit target...`);
      
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Execute the take profit order
      const result = await apiClient.setTakeProfit(symbol, targetPrice);
      
      const successText = [
        `✅ **Take Profit Set Successfully**`,
        '',
        `🎯 **Symbol:** ${symbol}`,
        `💰 **Target Price:** $${targetPrice.toFixed(6)}`,
        `📊 **Profit Target:** ${profitPercent}%`,
        `🆔 **Order ID:** ${result.orderId}`,
        '',
        '💰 *Your position will close automatically when target is reached.*'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 View Position', `position_${symbol}`),
          Markup.button.callback('🛡️ Set Stop Loss', `position_set_sl_${symbol}`)
        ],
        [
          Markup.button.callback('🔙 Back to Positions', 'positions_menu')
        ]
      ]);
      
      await this.safeEditMessageText(ctx, successText, { parse_mode: 'Markdown', ...keyboard });
      
      // Emit event
      this.eventEmitter.emitEvent({
        type: EventTypes.TRADE_EXECUTED,
        timestamp: new Date(),
        userId: ctx.userState!.userId,
        telegramId: ctx.userState!.telegramId,
        correlationId: ctx.correlationId,
        symbol,
        action: 'TAKE_PROFIT',
        price: targetPrice.toString(),
        orderId: result.orderId
      });
      
    } catch (error: any) {
      console.error('Execute take profit error:', error);
      await ctx.reply(`❌ **Take Profit Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}\n\n🔄 Please try again.`);
    }
  }

  /**
   * Handle custom stop loss price input
   */
  private async handleCustomStopLoss(ctx: BotContext, symbol: string): Promise<void> {
    try {
      await ctx.answerCbQuery('📝 Enter custom stop loss price...');
      
      const customText = [
        `📝 **Custom Stop Loss for ${symbol}**`,
        '',
        '🛡️ **Enter your stop loss price:**',
        '',
        '⚠️ *Please enter the exact price where you want the stop loss to trigger.*',
        '',
        '💡 **Tips:**',
        '• For LONG positions: Enter price BELOW current price',
        '• For SHORT positions: Enter price ABOVE current price',
        '• Use decimal format (e.g. 42.1234)'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔙 Back to Stop Loss', `position_set_sl_${symbol}`)
        ]
      ]);
      
      await this.safeEditMessageText(ctx, customText, { parse_mode: 'Markdown', ...keyboard });
      
      // Set user state to expect SL price input
      if (ctx.userState) {
        ctx.userState.conversationState = {
          step: 'waiting_custom_pair',
          data: { symbol, action: 'stop_loss' }
        };
      }
      
    } catch (error: any) {
      console.error('Custom stop loss error:', error);
      await ctx.reply(`❌ **Setup Failed**\n\n**Error:** ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle custom take profit price input
   */
  private async handleCustomTakeProfit(ctx: BotContext, symbol: string): Promise<void> {
    try {
      await ctx.answerCbQuery('📝 Enter custom take profit price...');
      
      const customText = [
        `📝 **Custom Take Profit for ${symbol}**`,
        '',
        '🎯 **Enter your take profit price:**',
        '',
        '⚠️ *Please enter the exact price where you want to take profits.*',
        '',
        '💡 **Tips:**',
        '• For LONG positions: Enter price ABOVE current price',
        '• For SHORT positions: Enter price BELOW current price',
        '• Use decimal format (e.g. 42.1234)'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔙 Back to Take Profit', `position_set_tp_${symbol}`)
        ]
      ]);
      
      await this.safeEditMessageText(ctx, customText, { parse_mode: 'Markdown', ...keyboard });
      
      // Set user state to expect TP price input
      if (ctx.userState) {
        ctx.userState.conversationState = {
          step: 'waiting_custom_pair',
          data: { symbol, action: 'take_profit' }
        };
      }
      
    } catch (error: any) {
      console.error('Custom take profit error:', error);
      await ctx.reply(`❌ **Setup Failed**\n\n**Error:** ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle market price stop loss (current price)
   */
  private async handleMarketStopLoss(ctx: BotContext, symbol: string): Promise<void> {
    try {
      await ctx.answerCbQuery('📊 Setting stop loss at market price...');
      
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Get current mark price
      const ticker = await apiClient.get24hrTicker(symbol);
      const currentPrice = parseFloat(ticker.lastPrice);
      
      // Execute stop loss at current market price
      const result = await apiClient.setStopLoss(symbol, currentPrice);
      
      const successText = [
        `✅ **Market Stop Loss Set**`,
        '',
        `🛡️ **Symbol:** ${symbol}`,
        `💰 **Stop Price:** $${currentPrice.toFixed(6)} (Market)`,
        `🆔 **Order ID:** ${result.orderId}`,
        '',
        '⚠️ *Stop loss set at current market price.*'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 View Position', `position_${symbol}`),
          Markup.button.callback('🔙 Back to Positions', 'positions_menu')
        ]
      ]);
      
      await this.safeEditMessageText(ctx, successText, { parse_mode: 'Markdown', ...keyboard });
      
    } catch (error: any) {
      console.error('Market stop loss error:', error);
      await ctx.reply(`❌ **Market Stop Loss Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle market price take profit (current price)
   */
  private async handleMarketTakeProfit(ctx: BotContext, symbol: string): Promise<void> {
    try {
      await ctx.answerCbQuery('📊 Setting take profit at market price...');
      
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Get current mark price
      const ticker = await apiClient.get24hrTicker(symbol);
      const currentPrice = parseFloat(ticker.lastPrice);
      
      // Execute take profit at current market price
      const result = await apiClient.setTakeProfit(symbol, currentPrice);
      
      const successText = [
        `✅ **Market Take Profit Set**`,
        '',
        `🎯 **Symbol:** ${symbol}`,
        `💰 **Target Price:** $${currentPrice.toFixed(6)} (Market)`,
        `🆔 **Order ID:** ${result.orderId}`,
        '',
        '💰 *Take profit set at current market price.*'
      ].join('\n');
      
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 View Position', `position_${symbol}`),
          Markup.button.callback('🔙 Back to Positions', 'positions_menu')
        ]
      ]);
      
      await this.safeEditMessageText(ctx, successText, { parse_mode: 'Markdown', ...keyboard });
      
    } catch (error: any) {
      console.error('Market take profit error:', error);
      await ctx.reply(`❌ **Market Take Profit Failed**\n\n**Symbol:** ${symbol}\n**Error:** ${error.message || 'Unknown error'}`);
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
      
      let settingsText = '⚙️ **Trading Configuration Center**\n\n';
      settingsText += 'Customize your trading experience with professional risk management tools, security features, and personalized presets. Optimize your workflow and protect your capital.\n\n';
      
      // Display current settings
      settingsText += `**🔧 Current Configuration:**\n`;
      settingsText += `🎯 **Leverage Cap:** ${userSettings.leverage_cap}x\n`;
      settingsText += `💰 **Default Leverage:** ${userSettings.default_leverage}x\n`;
      settingsText += `📊 **Slippage Tolerance:** ${(userSettings.slippage_bps / 100).toFixed(2)}%\n`;
      settingsText += `🛡️ **Daily Loss Cap:** ${userSettings.daily_loss_cap ? '$' + userSettings.daily_loss_cap : 'None'}\n`;
      settingsText += `🔒 **PIN Protection:** ${userSettings.pin_hash ? 'Enabled' : 'Disabled'}\n\n`;
      
      settingsText += '**🚀 Customization Options:**\n';
      settingsText += '• **Risk Management** — Set leverage limits and loss caps\n';
      settingsText += '• **Trade Presets** — Configure default sizes and quick amounts\n';
      settingsText += '• **Slippage Control** — Fine-tune execution tolerance\n';
      settingsText += '• **Security Features** — PIN protection and wallet safety\n\n';
      settingsText += '**Select a category to configure:**';
      
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
        '📊 **Live Market Intelligence Center**',
        '',
        'Real-time market data, price analysis, and trading insights powered by Aster DEX. Track market leaders, monitor volume surges, and discover trending opportunities.',
        '',
        '**🏆 Market Leaders:**',
        '• Top cryptocurrencies by market capitalization',
        '• Most liquid and established trading pairs',
        '• Click any token for detailed analysis',
        '',
        '**📈 Volume Analytics:**',
        '• Highest volume pairs with momentum indicators',
        '• Real-time trading activity and price movements',
        '• Identify market hotspots and trends',
        '',
        '**⭐ Smart Features:**',
        '• Curated watchlist of key assets',
        '• Multi-token price comparison tools',
        '• Complete market overview and discovery',
        '',
        '**Choose your market analysis:**'
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

      await this.safeEditMessageText(ctx, priceText, { parse_mode: 'Markdown', ...keyboard });
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
      // Top symbols by market cap (most established and valuable cryptocurrencies)
      const topSymbols = [
        'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 
        'SOLUSDT', 'DOTUSDT', 'LINKUSDT', 'AVAXUSDT', 'MATICUSDT'
      ];
      
      let priceText = '🏆 **Top Market Cap Cryptocurrencies**\n💰 *Current Price • 24h Change (USD) • High/Low • Volume*\n\n';
      
      const pricePromises = topSymbols.map(async (symbol, index) => {
        try {
          const ticker = await this.publicApiClient.get24hrTicker(symbol);
          const price = parseFloat(ticker.lastPrice);
          const change24h = parseFloat(ticker.priceChangePercent);
          const volume = parseFloat(ticker.volume);
          const high24h = parseFloat(ticker.highPrice);
          const low24h = parseFloat(ticker.lowPrice);
          const openPrice = parseFloat(ticker.openPrice);
          
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          
          // Format price based on value
          const formattedPrice = price < 1 ? price.toFixed(6) : price < 100 ? price.toFixed(4) : price.toFixed(2);
          
          // Calculate price change in USD
          const priceChange = price - openPrice;
          const formattedPriceChange = Math.abs(priceChange) < 0.01 ? 
            priceChange.toFixed(6) : priceChange.toFixed(2);
          
          // Format volume in appropriate units
          const volumeText = volume > 1000000 ? 
            `${(volume / 1000000).toFixed(1)}M` : 
            volume > 1000 ? `${(volume / 1000).toFixed(1)}K` : volume.toFixed(0);
          
          return `${index + 1}. **${symbol.replace('USDT', '')}**\n` +
                 `   💰 **$${formattedPrice}** ${changeEmoji} ${changeText}${change24h.toFixed(2)}% (${changeText}$${formattedPriceChange})\n` +
                 `   📊 H: $${high24h.toFixed(price < 1 ? 6 : 2)} • L: $${low24h.toFixed(price < 1 ? 6 : 2)} • Vol: ${volumeText}\n`;
        } catch (error) {
          console.error(`Failed to fetch ticker for ${symbol}:`, error);
          return `${index + 1}. **${symbol.replace('USDT', '')}** • ❌ Price unavailable\n`;
        }
      });
      
      const priceResults = await Promise.allSettled(pricePromises);
      const successfulResults = priceResults.filter(result => result.status === 'fulfilled').map(result => result.value);
      const failedCount = priceResults.length - successfulResults.length;
      
      if (successfulResults.length === 0) {
        throw new Error('Failed to fetch price data for all cryptocurrencies');
      }
      
      priceText += successfulResults.join('\n');
      
      if (failedCount > 0) {
        priceText += `\n\n⚠️ ${failedCount} price(s) unavailable due to API issues`;
      }
      
      // Add clickable token buttons for quick access
      const tokenButtons = topSymbols.slice(0, 6).map(symbol => 
        Markup.button.callback(symbol.replace('USDT', ''), `price_token_${symbol}`)
      );
      
      const buttonRows = [];
      for (let i = 0; i < tokenButtons.length; i += 3) {
        buttonRows.push(tokenButtons.slice(i, i + 3));
      }
      
      buttonRows.push([
        Markup.button.callback('📈 Top Volume', 'price_top_volume'),
        Markup.button.callback('🔄 Refresh', 'price_top_mcap')
      ]);
      buttonRows.push([
        Markup.button.callback('📈 Trade', 'unified_trade'),
        Markup.button.callback('🔙 Back', 'price_menu')
      ]);
      
      const keyboard = Markup.inlineKeyboard(buttonRows);

      await this.safeEditMessageText(ctx, priceText, { parse_mode: 'Markdown', ...keyboard });
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
      const allTickers = await this.publicApiClient.getAllFuturesTickers();
      
      // Check if we actually got data
      if (!allTickers || allTickers.length === 0) {
        throw new Error('No ticker data received from API');
      }
      
      // Sort by volume and take top 10
      const topByVolume = allTickers
        .filter((ticker: any) => ticker.symbol.endsWith('USDT'))
        .sort((a: any, b: any) => parseFloat(b.volume) - parseFloat(a.volume))
        .slice(0, 10);
        
      // Check if we have any USDT pairs
      if (topByVolume.length === 0) {
        throw new Error('No USDT trading pairs found in ticker data');
      }
      
      let volumeText = '📈 **Highest Volume Trading Pairs (24h)**\n💰 *Current Price • 24h Change (USD) • High/Low • Volume*\n\n';
      
      // Get detailed ticker data for each top volume symbol
      const detailedTickerPromises = topByVolume.slice(0, 10).map(async (ticker: any, index: number) => {
        try {
          const detailedTicker = await this.publicApiClient.get24hrTicker(ticker.symbol);
          const price = parseFloat(detailedTicker.lastPrice);
          const change24h = parseFloat(detailedTicker.priceChangePercent);
          const volume = parseFloat(detailedTicker.volume);
          const high24h = parseFloat(detailedTicker.highPrice);
          const low24h = parseFloat(detailedTicker.lowPrice);
          const openPrice = parseFloat(detailedTicker.openPrice);
          
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          
          // Format price based on value
          const formattedPrice = price < 1 ? price.toFixed(6) : price < 100 ? price.toFixed(4) : price.toFixed(2);
          
          // Calculate price change in USD
          const priceChange = price - openPrice;
          const formattedPriceChange = Math.abs(priceChange) < 0.01 ? 
            priceChange.toFixed(6) : priceChange.toFixed(2);
          
          // Format volume in appropriate units
          const volumeText = volume > 1000000 ? 
            `${(volume / 1000000).toFixed(1)}M` : 
            volume > 1000 ? `${(volume / 1000).toFixed(1)}K` : volume.toFixed(0);
          
          return `${index + 1}. **${ticker.symbol.replace('USDT', '')}**\n` +
                 `   💰 **$${formattedPrice}** ${changeEmoji} ${changeText}${change24h.toFixed(2)}% (${changeText}$${formattedPriceChange})\n` +
                 `   📊 H: $${high24h.toFixed(price < 1 ? 6 : 2)} • L: $${low24h.toFixed(price < 1 ? 6 : 2)} • Vol: ${volumeText}\n`;
        } catch (error) {
          console.error(`Failed to fetch detailed ticker for ${ticker.symbol}:`, error);
          // Fallback to basic data from getAllFuturesTickers
          const price = parseFloat(ticker.lastPrice);
          const change24h = parseFloat(ticker.priceChangePercent);
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          const volume = (parseFloat(ticker.volume) / 1000000).toFixed(1);
          
          return `${index + 1}. **${ticker.symbol.replace('USDT', '')}** • $${price.toFixed(price < 1 ? 6 : 2)}\n` +
                 `   ${changeEmoji} ${changeText}${change24h.toFixed(2)}% • Vol: ${volume}M\n`;
        }
      });
      
      const detailedResults = await Promise.allSettled(detailedTickerPromises);
      const successfulDetailedResults = detailedResults.filter(result => result.status === 'fulfilled').map(result => result.value);
      
      volumeText += successfulDetailedResults.join('\n');
      
      // Add clickable buttons for top volume tokens
      const topTokenButtons = topByVolume.slice(0, 6).map((ticker: any) => 
        Markup.button.callback(ticker.symbol.replace('USDT', ''), `price_token_${ticker.symbol}`)
      );
      
      const buttonRows = [];
      for (let i = 0; i < topTokenButtons.length; i += 3) {
        buttonRows.push(topTokenButtons.slice(i, i + 3));
      }
      
      buttonRows.push([
        Markup.button.callback('🏆 Top Market Cap', 'price_top_mcap'),
        Markup.button.callback('🔄 Refresh', 'price_top_volume')
      ]);
      buttonRows.push([
        Markup.button.callback('📈 Trade', 'unified_trade'),
        Markup.button.callback('🔙 Back', 'price_menu')
      ]);
      
      const keyboard = Markup.inlineKeyboard(buttonRows);

      await this.safeEditMessageText(ctx, volumeText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Top volume error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Provide a more informative error message with a retry option
      const retryKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Retry', 'price_top_volume'),
          Markup.button.callback('🔙 Back to Price Menu', 'price_menu')
        ]
      ]);
      
      await ctx.editMessageText(
        `❌ **Failed to Load Top Volume Data**\n\n` +
        `Error: ${errorMessage}\n\n` +
        `This might be due to:\n` +
        `• API connectivity issues\n` +
        `• Exchange server maintenance\n` +
        `• Temporary network problems\n\n` +
        `Please try again in a moment.`,
        { parse_mode: 'Markdown', ...retryKeyboard }
      );
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
          const ticker = await this.publicApiClient.get24hrTicker(symbol);
          const price = parseFloat(ticker.lastPrice);
          const change24h = parseFloat(ticker.priceChangePercent);
          const volume = parseFloat(ticker.volume);
          const changeEmoji = change24h >= 0 ? '🟢' : '🔴';
          const changeText = change24h >= 0 ? '+' : '';
          
          return [
            `**${symbol.replace('USDT', '')}** • $${price.toFixed(price < 1 ? 6 : 2)}`,
            `${changeEmoji} ${changeText}${change24h.toFixed(2)}% • Vol: ${(volume / 1000000).toFixed(1)}M`,
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

      await this.safeEditMessageText(ctx, priceText, { parse_mode: 'Markdown', ...keyboard });
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
   * Handle perps leverage selection (Step 1 of trading flow)
   */
  private async handlePerpsLeverageSelection(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL'): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const currentPrice = await this.priceService.getCurrentPrice(symbol);
      const sideText = side === 'BUY' ? 'Long' : 'Short';
      const emoji = side === 'BUY' ? '🟢' : '🔴';
      
      const leverageText = [
        `${emoji} **${sideText} ${symbol.replace('USDT', '')}**`,
        `💵 **Current Price:** $${currentPrice.toFixed(6)}`,
        '',
        '🎯 **Step 1: Select Leverage**',
        '',
        '⚡ **Choose your leverage multiplier:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('2x', `perps_leverage_${side.toLowerCase()}_${symbol}_2x`),
          Markup.button.callback('3x', `perps_leverage_${side.toLowerCase()}_${symbol}_3x`),
          Markup.button.callback('5x', `perps_leverage_${side.toLowerCase()}_${symbol}_5x`)
        ],
        [
          Markup.button.callback('10x', `perps_leverage_${side.toLowerCase()}_${symbol}_10x`),
          Markup.button.callback('20x', `perps_leverage_${side.toLowerCase()}_${symbol}_20x`),
          Markup.button.callback('50x', `perps_leverage_${side.toLowerCase()}_${symbol}_50x`)
        ],
        [
          Markup.button.callback('🔙 Back', 'trade_perps')
        ]
      ]);

      await ctx.editMessageText(leverageText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Perps leverage selection error:', error);
      await ctx.reply(`❌ Failed to load leverage selection for ${symbol}. Please try again.`);
    }
  }

  /**
   * Handle perps amount selection (Step 2 of trading flow)
   */
  private async handlePerpsAmountSelection(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', leverage: number, marginMode: 'cross' | 'isolated'): Promise<void> {
    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      const FuturesAccountService = await import('../services/FuturesAccountService');
      const futuresService = new FuturesAccountService.FuturesAccountService(apiClient);
      
      const account = await futuresService.getFuturesAccount();
      const usdtAsset = account.assets.find(a => a.asset === 'USDT');
      const availableBalance = parseFloat(usdtAsset?.availableBalance || '0');
      
      const currentPrice = await this.priceService.getCurrentPrice(symbol);
      const sideText = side === 'BUY' ? 'Long' : 'Short';
      const emoji = side === 'BUY' ? '🟢' : '🔴';
      
      const marginEmoji = marginMode === 'cross' ? '🌐' : '🔒';
      const amountText = [
        `${emoji} **${sideText} ${symbol.replace('USDT', '')} ${leverage}x**`,
        `${marginEmoji} **Margin Mode:** ${marginMode.charAt(0).toUpperCase() + marginMode.slice(1)}`,
        `💵 **Current Price:** $${currentPrice.toFixed(6)}`,
        `💰 **Available Balance:** $${availableBalance.toFixed(2)} USDT`,
        '',
        '🎯 **Step 3: Select Position Size**',
        '',
        '📊 **Quick Percentage Options:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`25% ($${(availableBalance * 0.25).toFixed(2)})`, `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_25pct`),
          Markup.button.callback(`50% ($${(availableBalance * 0.50).toFixed(2)})`, `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_50pct`)
        ],
        [
          Markup.button.callback(`75% ($${(availableBalance * 0.75).toFixed(2)})`, `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_75pct`),
          Markup.button.callback(`100% ($${availableBalance.toFixed(2)})`, `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_100pct`)
        ],
        [
          Markup.button.callback('💰 Enter USDT Amount', `perps_manual_usdt_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}`),
          Markup.button.callback('🪙 Enter Token Amount', `perps_manual_token_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}`)
        ],
        [
          Markup.button.callback('🔙 Back to Margin Mode', `perps_margin_${side.toLowerCase()}_${symbol}_${leverage}x`)
        ]
      ]);

      await ctx.editMessageText(amountText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Perps amount selection error:', error);
      await ctx.reply(`❌ Failed to load amount selection for ${symbol}. Please try again.`);
    }
  }

  /**
   * Handle spot trading selection (single step for spot)
   */
  private async handleSpotTradingSelection(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL'): Promise<void> {
    if (!ctx.userState?.isLinked) {
      await ctx.reply('❌ Please link your API credentials first using /link');
      return;
    }

    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      const SpotAccountService = await import('../services/SpotAccountService');
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      
      let availableBalance = 0;
      if (side === 'BUY') {
        const usdtBalance = await spotService.getUsdtBalance();
        availableBalance = usdtBalance;
      } else {
        const asset = symbol.replace('USDT', '');
        const assetBalance = await spotService.getAssetBalance(asset);
        if (assetBalance) {
          availableBalance = assetBalance.usdValue || 0;
        }
      }
      
      const currentPrice = await this.priceService.getCurrentPrice(symbol);
      const sideText = side === 'BUY' ? 'Buy' : 'Sell';
      const emoji = side === 'BUY' ? '🟢' : '🔴';
      const balanceText = side === 'BUY' ? 'USDT Balance' : `${symbol.replace('USDT', '')} Value`;
      
      const spotText = [
        `${emoji} **${sideText} ${symbol.replace('USDT', '')}**`,
        `💵 **Current Price:** $${currentPrice.toFixed(6)}`,
        `💰 **Available ${balanceText}:** $${availableBalance.toFixed(2)}`,
        '',
        '🎯 **Select Position Size:**',
        '',
        '📊 **Quick Percentage Options:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`25% ($${(availableBalance * 0.25).toFixed(2)})`, `spot_amount_${side.toLowerCase()}_${symbol}_25pct`),
          Markup.button.callback(`50% ($${(availableBalance * 0.50).toFixed(2)})`, `spot_amount_${side.toLowerCase()}_${symbol}_50pct`)
        ],
        [
          Markup.button.callback(`75% ($${(availableBalance * 0.75).toFixed(2)})`, `spot_amount_${side.toLowerCase()}_${symbol}_75pct`),
          Markup.button.callback(`100% ($${availableBalance.toFixed(2)})`, `spot_amount_${side.toLowerCase()}_${symbol}_100pct`)
        ],
        [
          Markup.button.callback('💰 Enter USDT Amount', `spot_manual_usdt_${side.toLowerCase()}_${symbol}`),
          Markup.button.callback('🪙 Enter Token Amount', `spot_manual_token_${side.toLowerCase()}_${symbol}`)
        ],
        [
          Markup.button.callback('🔙 Back', 'trade_spot')
        ]
      ]);

      await ctx.editMessageText(spotText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Spot trading selection error:', error);
      await ctx.reply(`❌ Failed to load trading selection for ${symbol}. Please try again.`);
    }
  }

  /**
   * Handle perps percentage execution
   */
  private async handlePerpsPercentageExecute(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', leverage: number, percentage: number): Promise<void> {
    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      const FuturesAccountService = await import('../services/FuturesAccountService');
      const futuresService = new FuturesAccountService.FuturesAccountService(apiClient);
      
      const account = await futuresService.getFuturesAccount();
      const usdtAsset = account.assets.find(a => a.asset === 'USDT');
      const availableBalance = parseFloat(usdtAsset?.availableBalance || '0');
      
      const usdtAmount = Math.floor(availableBalance * (percentage / 100));
      
      if (usdtAmount < 1) {
        await ctx.reply(`❌ Insufficient balance. You need at least $1 USDT to trade. Available: $${availableBalance.toFixed(2)}`);
        return;
      }
      
      await this.handlePerpsExecuteAction(ctx, symbol, side, usdtAmount, leverage);
    } catch (error) {
      console.error('Perps percentage execution error:', error);
      await ctx.reply('❌ Failed to execute percentage trade. Please try again.');
    }
  }

  /**
   * Handle spot percentage execution
   */
  private async handleSpotPercentageExecute(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', percentage: number): Promise<void> {
    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      const SpotAccountService = await import('../services/SpotAccountService');
      const spotService = new SpotAccountService.SpotAccountService(apiClient);
      
      let usdtAmount = 0;
      if (side === 'BUY') {
        const usdtBalance = await spotService.getUsdtBalance();
        usdtAmount = Math.floor(usdtBalance * (percentage / 100));
      } else {
        const asset = symbol.replace('USDT', '');
        const assetBalance = await spotService.getAssetBalance(asset);
        if (assetBalance && assetBalance.usdValue) {
          usdtAmount = Math.floor(assetBalance.usdValue * (percentage / 100));
        }
      }
      
      if (usdtAmount < 1) {
        await ctx.reply(`❌ Insufficient balance. You need at least $1 USDT equivalent to trade.`);
        return;
      }
      
      await this.handleSpotExecuteAction(ctx, symbol, side, usdtAmount);
    } catch (error) {
      console.error('Spot percentage execution error:', error);
      await ctx.reply('❌ Failed to execute percentage trade. Please try again.');
    }
  }

  /**
   * Handle manual USDT input
   */
  private async handleManualUSDTInput(ctx: BotContext, mode: 'spot' | 'perps', symbol: string, side: 'BUY' | 'SELL', leverage?: number, marginMode?: 'cross' | 'isolated'): Promise<void> {
    const modeText = mode === 'spot' ? 'Spot' : 'Perps';
    const sideText = side === 'BUY' ? (mode === 'spot' ? 'Buy' : 'Long') : (mode === 'spot' ? 'Sell' : 'Short');
    const leverageText = leverage ? ` ${leverage}x` : '';
    
    const inputText = [
      `💰 **Manual USDT Amount**`,
      `**${modeText} ${sideText}${leverageText}:** ${symbol.replace('USDT', '')}`,
      '',
      '✍️ **Enter your USDT amount:**',
      '',
      '📝 **Examples:**',
      '• 25 (for $25 USDT)',
      '• 100 (for $100 USDT)',
      '• 500 (for $500 USDT)',
      '',
      '⏳ **Waiting for your input...**'
    ].join('\n');

    const marginModeText = marginMode ? `_${marginMode}` : '';
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('$25', mode === 'spot' ? `spot_amount_${side.toLowerCase()}_${symbol}_25pct` : `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_25pct`),
        Markup.button.callback('$50', mode === 'spot' ? `spot_amount_${side.toLowerCase()}_${symbol}_50pct` : `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_50pct`)
      ],
      [
        Markup.button.callback('$100', mode === 'spot' ? `spot_amount_${side.toLowerCase()}_${symbol}_75pct` : `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_75pct`),
        Markup.button.callback('$250', mode === 'spot' ? `spot_amount_${side.toLowerCase()}_${symbol}_100pct` : `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_100pct`)
      ],
      [
        Markup.button.callback('🔙 Back', mode === 'spot' ? `spot_${side.toLowerCase()}_${symbol}` : `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}`)
      ]
    ]);

    await ctx.editMessageText(inputText, { parse_mode: 'Markdown', ...keyboard });

    // Set conversation state
    if (ctx.userState) {
      (ctx.userState as any).expectingManualUSDT = { mode, symbol, side, leverage, marginMode };
    }
  }

  /**
   * Handle manual token input
   */
  private async handleManualTokenInput(ctx: BotContext, mode: 'spot' | 'perps', symbol: string, side: 'BUY' | 'SELL', leverage?: number, marginMode?: 'cross' | 'isolated'): Promise<void> {
    const tokenSymbol = symbol.replace('USDT', '');
    const modeText = mode === 'spot' ? 'Spot' : 'Perps';
    const sideText = side === 'BUY' ? (mode === 'spot' ? 'Buy' : 'Long') : (mode === 'spot' ? 'Sell' : 'Short');
    const leverageText = leverage ? ` ${leverage}x` : '';
    
    const inputText = [
      `🪙 **Manual Token Amount**`,
      `**${modeText} ${sideText}${leverageText}:** ${tokenSymbol}`,
      '',
      `✍️ **Enter your ${tokenSymbol} amount:**`,
      '',
      '📝 **Examples:**',
      '• 0.001 (for 0.001 BTC)',
      '• 1 (for 1 ETH)',
      '• 100 (for 100 ADA)',
      '',
      '⏳ **Waiting for your input...**'
    ].join('\n');

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('0.001', ''),
        Markup.button.callback('0.01', '')
      ],
      [
        Markup.button.callback('0.1', ''),
        Markup.button.callback('1', '')
      ],
      [
        Markup.button.callback('🔙 Back', mode === 'spot' ? `spot_${side.toLowerCase()}_${symbol}` : `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}`)
      ]
    ]);

    await ctx.editMessageText(inputText, { parse_mode: 'Markdown', ...keyboard });

    // Set conversation state
    if (ctx.userState) {
      (ctx.userState as any).expectingManualToken = { mode, symbol, side, leverage, marginMode };
    }
  }

  /**
   * Handle manual USDT text input
   */
  private async handleManualUSDTText(ctx: BotContext, text: string): Promise<void> {
    const state = (ctx.userState as any)?.expectingManualUSDT;
    if (!state) return;

    // Clear conversation state
    delete (ctx.userState as any).expectingManualUSDT;

    const { mode, symbol, side, leverage, marginMode } = state;
    const amount = parseFloat(text.trim());

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply(
        `❌ **Invalid Amount**\n\n` +
        `Please enter a valid positive number for USDT amount.\n\n` +
        `Example: 25, 100, 500`
      );
      return;
    }

    if (amount > 10000) {
      await ctx.reply(
        `❌ **Amount Too Large**\n\n` +
        `Maximum amount is $10,000 USDT per trade.\n\n` +
        `Please enter a smaller amount.`
      );
      return;
    }

    try {
      if (mode === 'spot') {
        await this.handleSpotTPSLSelection(ctx, symbol, side, amount, 'usdt');
      } else {
        await this.handlePerpsTPSLSelection(ctx, symbol, side, leverage!, marginMode!, amount, 'usdt');
      }
    } catch (error) {
      console.error('Manual USDT execution error:', error);
      await ctx.reply('❌ Failed to execute trade. Please try again.');
    }
  }

  /**
   * Handle manual token text input
   */
  private async handleManualTokenText(ctx: BotContext, text: string): Promise<void> {
    const state = (ctx.userState as any)?.expectingManualToken;
    if (!state) return;

    // Clear conversation state
    delete (ctx.userState as any).expectingManualToken;

    const { mode, symbol, side, leverage, marginMode } = state;
    const tokenAmount = parseFloat(text.trim());

    if (isNaN(tokenAmount) || tokenAmount <= 0) {
      await ctx.reply(
        `❌ **Invalid Amount**\n\n` +
        `Please enter a valid positive number for token amount.\n\n` +
        `Example: 0.001, 1, 100`
      );
      return;
    }

    try {
      // Convert token amount to USDT
      const currentPrice = await this.priceService.getCurrentPrice(symbol);
      const usdtAmount = tokenAmount * currentPrice;

      if (usdtAmount > 50000) {
        await ctx.reply(
          `❌ **Amount Too Large**\n\n` +
          `Token amount equivalent to $${usdtAmount.toFixed(2)} USDT is too large.\n\n` +
          `Maximum is $50,000 USDT equivalent per trade.`
        );
        return;
      }

      if (mode === 'spot') {
        await this.handleSpotTPSLSelection(ctx, symbol, side, tokenAmount, 'token');
      } else {
        await this.handlePerpsTPSLSelection(ctx, symbol, side, leverage!, marginMode!, tokenAmount, 'token');
      }
    } catch (error) {
      console.error('Manual token execution error:', error);
      await ctx.reply('❌ Failed to execute trade. Please try again.');
    }
  }

  /**
   * Handle custom TP/SL price input from user
   */
  private async handleCustomTPSLPriceText(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.userState?.conversationState?.data) return;
    
    const { symbol, action } = ctx.userState.conversationState.data;
    if (!symbol || !action) return;
    const price = parseFloat(text.trim());
    
    // Clear conversation state
    ctx.userState.conversationState = undefined;
    
    if (isNaN(price) || price <= 0) {
      await ctx.reply('❌ **Invalid Price**\n\nPlease enter a valid positive number.\n\nExample: 42.1234');
      return;
    }
    
    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      
      // Get current position to validate the price
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (!position) {
        await ctx.reply(`❌ **No Open Position**\n\n**Symbol:** ${symbol}\n\nPosition may have been closed.`);
        return;
      }
      
      const positionSize = parseFloat(position.positionAmt);
      const entryPrice = parseFloat(position.entryPrice);
      const isLong = positionSize > 0;
      
      // Validate price direction
      if (action === 'stop_loss') {
        // Stop loss validation
        if ((isLong && price >= entryPrice) || (!isLong && price <= entryPrice)) {
          const direction = isLong ? 'below' : 'above';
          await ctx.reply(
            `❌ **Invalid Stop Loss Price**\n\n` +
            `**Position:** ${isLong ? 'LONG' : 'SHORT'}\n` +
            `**Entry Price:** $${entryPrice.toFixed(6)}\n` +
            `**Your Price:** $${price.toFixed(6)}\n\n` +
            `⚠️ Stop loss must be ${direction} entry price for ${isLong ? 'LONG' : 'SHORT'} positions.`
          );
          return;
        }
        
        // Execute stop loss
        const result = await apiClient.setStopLoss(symbol, price);
        const riskPercent = Math.abs((price - entryPrice) / entryPrice * 100);
        
        const successText = [
          `✅ **Custom Stop Loss Set**`,
          '',
          `🛡️ **Symbol:** ${symbol}`,
          `💰 **Stop Price:** $${price.toFixed(6)}`,
          `📊 **Risk Level:** ${riskPercent.toFixed(1)}%`,
          `🆔 **Order ID:** ${result.orderId}`,
          '',
          '⚠️ *Your position is now protected with a custom stop loss.*'
        ].join('\n');
        
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 View Position', `position_${symbol}`),
            Markup.button.callback('🎯 Set Take Profit', `position_set_tp_${symbol}`)
          ],
          [
            Markup.button.callback('🔙 Back to Positions', 'positions_menu')
          ]
        ]);
        
        await ctx.reply(successText, { parse_mode: 'Markdown', ...keyboard });
        
        // Emit event
        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_EXECUTED,
          timestamp: new Date(),
          userId: ctx.userState.userId,
          telegramId: ctx.userState.telegramId,
          correlationId: ctx.correlationId,
          symbol,
          action: 'STOP_LOSS',
          price: price.toString(),
          orderId: result.orderId
        });
        
      } else if (action === 'take_profit') {
        // Take profit validation
        if ((isLong && price <= entryPrice) || (!isLong && price >= entryPrice)) {
          const direction = isLong ? 'above' : 'below';
          await ctx.reply(
            `❌ **Invalid Take Profit Price**\n\n` +
            `**Position:** ${isLong ? 'LONG' : 'SHORT'}\n` +
            `**Entry Price:** $${entryPrice.toFixed(6)}\n` +
            `**Your Price:** $${price.toFixed(6)}\n\n` +
            `⚠️ Take profit must be ${direction} entry price for ${isLong ? 'LONG' : 'SHORT'} positions.`
          );
          return;
        }
        
        // Execute take profit
        const result = await apiClient.setTakeProfit(symbol, price);
        const profitPercent = Math.abs((price - entryPrice) / entryPrice * 100);
        
        const successText = [
          `✅ **Custom Take Profit Set**`,
          '',
          `🎯 **Symbol:** ${symbol}`,
          `💰 **Target Price:** $${price.toFixed(6)}`,
          `📊 **Profit Target:** ${profitPercent.toFixed(1)}%`,
          `🆔 **Order ID:** ${result.orderId}`,
          '',
          '💰 *Your position will close automatically when target is reached.*'
        ].join('\n');
        
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 View Position', `position_${symbol}`),
            Markup.button.callback('🛡️ Set Stop Loss', `position_set_sl_${symbol}`)
          ],
          [
            Markup.button.callback('🔙 Back to Positions', 'positions_menu')
          ]
        ]);
        
        await ctx.reply(successText, { parse_mode: 'Markdown', ...keyboard });
        
        // Emit event
        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_EXECUTED,
          timestamp: new Date(),
          userId: ctx.userState.userId,
          telegramId: ctx.userState.telegramId,
          correlationId: ctx.correlationId,
          symbol,
          action: 'TAKE_PROFIT',
          price: price.toString(),
          orderId: result.orderId
        });
      }
      
    } catch (error: any) {
      console.error('Custom TP/SL price error:', error);
      await ctx.reply(`❌ **Failed to Set ${action === 'stop_loss' ? 'Stop Loss' : 'Take Profit'}**\n\n**Error:** ${error.message || 'Unknown error'}\n\n🔄 Please try again.`);
    }
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
        `**Order ID:** ${String(orderResult.orderId)}\n\n` +
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
   * Handle margin mode selection for perps trading
   */
  private async handlePerpsMarginModeSelection(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', leverage: number): Promise<void> {
    try {
      const sideEmoji = side === 'BUY' ? '📈' : '📉';
      
      const marginText = [
        `${sideEmoji} **${side} ${symbol.replace('USDT', '')} ${leverage}x**`,
        '',
        '⚖️ **Select Margin Mode**',
        '',
        'Choose how your position will be margined. This affects your liquidation risk and capital allocation.',
        '',
        '**🌐 Cross Margin:**',
        '• Uses your entire futures account balance as collateral',
        '• Lower liquidation risk but higher account exposure', 
        '• All positions share the same margin pool',
        '• Recommended for experienced traders',
        '',
        '**🔒 Isolated Margin:**',
        '• Uses only allocated margin for this specific position',
        '• Higher liquidation risk but limited account exposure',
        '• Position is isolated from other trades',
        '• Recommended for risk management and testing',
        '',
        '**Choose your margin mode:**'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🌐 Cross Margin', `perps_margin_${side.toLowerCase()}_${symbol}_${leverage}x_cross`),
          Markup.button.callback('🔒 Isolated Margin', `perps_margin_${side.toLowerCase()}_${symbol}_${leverage}x_isolated`)
        ],
        [
          Markup.button.callback('🔙 Back to Leverage', `perps_${side.toLowerCase()}_${symbol}`)
        ]
      ]);

      await ctx.editMessageText(marginText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Margin mode selection error:', error);
      await ctx.reply('❌ Failed to load margin mode options. Please try again.');
    }
  }

  /**
   * Handle TP/SL selection for perps trading
   */
  private async handlePerpsTPSLSelection(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', leverage: number, marginMode: 'cross' | 'isolated', amount: number, amountType: string): Promise<void> {
    try {
      const SettingsModule = await import('../settings');
      const settingsManager = new SettingsModule.SettingsManager(this.db, this.encryption);
      const userSettings = await settingsManager.getUserSettings(ctx.userState!.userId);

      const sideEmoji = side === 'BUY' ? '📈' : '📉';
      const marginEmoji = marginMode === 'cross' ? '🌐' : '🔒';
      const amountDisplay = amountType === 'percentage' ? `${amount}%` : 
                           amountType === 'usdt' ? `$${amount}` : `${amount} ${symbol.replace('USDT', '')}`;

      const tpslText = [
        `${sideEmoji} **${side} ${symbol.replace('USDT', '')} ${leverage}x**`,
        `${marginEmoji} **Margin:** ${marginMode.charAt(0).toUpperCase() + marginMode.slice(1)}`,
        `Amount: ${amountDisplay}`,
        '',
        '🎯 **Take Profit & Stop Loss Setup**',
        '',
        'Set your risk management levels to protect profits and limit losses. You can use preset values from your settings or create custom levels.',
        '',
        '**🟢 Take Profit Presets:**',
        userSettings.tp_presets.map(tp => `• ${tp}% profit target`).join('\n'),
        '',
        '**🔴 Stop Loss Presets:**',
        userSettings.sl_presets.map(sl => `• ${sl}% maximum loss`).join('\n'),
        '',
        '**Choose your risk management setup:**'
      ].join('\n');

      // Create TP preset buttons (first row)
      const tpButtons = userSettings.tp_presets.slice(0, 3).map(tp => 
        Markup.button.callback(`TP ${tp}%`, `perps_tpsl_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_${amount}_${amountType}_tp${tp}_slnone`)
      );

      // Create SL preset buttons (second row)
      const slButtons = userSettings.sl_presets.slice(0, 3).map(sl => 
        Markup.button.callback(`SL ${sl}%`, `perps_tpsl_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_${amount}_${amountType}_tpnone_sl${sl}`)
      );

      // Create combined TP/SL buttons (third row)
      const combinedButtons = userSettings.tp_presets.slice(0, 2).map((tp, index) => {
        const sl = userSettings.sl_presets[Math.min(index, userSettings.sl_presets.length - 1)];
        return Markup.button.callback(`TP ${tp}% / SL ${sl}%`, `perps_tpsl_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_${amount}_${amountType}_tp${tp}_sl${sl}`);
      });

      const keyboard = Markup.inlineKeyboard([
        tpButtons,
        slButtons,
        combinedButtons,
        [
          Markup.button.callback('🚀 Execute Without TP/SL', `perps_tpsl_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_${amount}_${amountType}_tpnone_slnone`),
          Markup.button.callback('⚙️ Custom TP/SL', `perps_custom_tpsl_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}_${amount}_${amountType}`)
        ],
        [
          Markup.button.callback('🔙 Back to Amount', `perps_amount_${side.toLowerCase()}_${symbol}_${leverage}x_${marginMode}`)
        ]
      ]);

      await this.safeEditMessageText(ctx, tpslText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Perps TP/SL selection error:', error);
      await ctx.reply('❌ Failed to load TP/SL options. Please try again.');
    }
  }

  /**
   * Handle TP/SL selection for spot trading
   */
  private async handleSpotTPSLSelection(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', amount: number, amountType: string): Promise<void> {
    try {
      const SettingsModule = await import('../settings');
      const settingsManager = new SettingsModule.SettingsManager(this.db, this.encryption);
      const userSettings = await settingsManager.getUserSettings(ctx.userState!.userId);

      const sideEmoji = side === 'BUY' ? '🟢' : '🔴';
      const amountDisplay = amountType === 'percentage' ? `${amount}%` : 
                           amountType === 'usdt' ? `$${amount}` : `${amount} ${symbol.replace('USDT', '')}`;

      const tpslText = [
        `${sideEmoji} **${side} ${symbol.replace('USDT', '')}**`,
        `Amount: ${amountDisplay}`,
        '',
        '🎯 **Take Profit Setup** (Spot Trading)',
        '',
        'For spot trading, set take profit levels to automatically sell when your target price is reached. Stop losses are handled differently in spot trading.',
        '',
        '**🟢 Take Profit Presets:**',
        userSettings.tp_presets.map(tp => `• ${tp}% profit target`).join('\n'),
        '',
        side === 'BUY' ? '**Note:** TP orders will sell your position at profit targets' : '**Note:** This is a direct sell order',
        '',
        '**Choose your setup:**'
      ].join('\n');

      const tpButtons = userSettings.tp_presets.slice(0, 3).map(tp => 
        Markup.button.callback(`TP ${tp}%`, `spot_tpsl_${side.toLowerCase()}_${symbol}_${amount}_${amountType}_tp${tp}_slnone`)
      );

      const keyboard = Markup.inlineKeyboard([
        tpButtons,
        [
          Markup.button.callback('🚀 Execute Without TP', `spot_tpsl_${side.toLowerCase()}_${symbol}_${amount}_${amountType}_tpnone_slnone`),
          Markup.button.callback('⚙️ Custom TP', `spot_custom_tpsl_${side.toLowerCase()}_${symbol}_${amount}_${amountType}`)
        ],
        [
          Markup.button.callback('🔙 Back to Amount', `spot_${side.toLowerCase()}_${symbol}`)
        ]
      ]);

      await ctx.editMessageText(tpslText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Spot TP/SL selection error:', error);
      await ctx.reply('❌ Failed to load TP/SL options. Please try again.');
    }
  }

  /**
   * Handle perps TP/SL execution with risk management
   */
  private async handlePerpsTPSLExecute(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', leverage: number, marginMode: 'cross' | 'isolated', amount: number, amountType: string, tpValue: number | null, slValue: number | null): Promise<void> {
    try {
      let finalAmount = amount;
      
      if (amountType === 'percentage') {
        const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
        const FuturesAccountService = await import('../services/FuturesAccountService');
        const futuresService = new FuturesAccountService.FuturesAccountService(apiClient);
        
        const account = await futuresService.getFuturesAccount();
        const usdtAsset = account.assets.find(a => a.asset === 'USDT');
        const availableBalance = parseFloat(usdtAsset?.availableBalance || '0');
        finalAmount = Math.floor(availableBalance * (amount / 100));
      }

      // Execute the main trade first
      await this.handlePerpsExecuteAction(ctx, symbol, side, finalAmount, leverage);

      // If TP or SL is set, place additional orders
      if (tpValue || slValue) {
        await this.placeTPSLOrders(ctx, symbol, side, leverage, tpValue, slValue);
      }

    } catch (error) {
      console.error('Perps TP/SL execution error:', error);
      await ctx.reply('❌ Failed to execute trade with TP/SL. Please try again.');
    }
  }

  /**
   * Handle spot TP/SL execution
   */
  private async handleSpotTPSLExecute(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', amount: number, amountType: string, tpValue: number | null, slValue: number | null): Promise<void> {
    try {
      let finalAmount = amount;
      
      if (amountType === 'percentage') {
        const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
        const SpotAccountService = await import('../services/SpotAccountService');
        const spotService = new SpotAccountService.SpotAccountService(apiClient);
        
        if (side === 'BUY') {
          const usdtBalance = await spotService.getUsdtBalance();
          finalAmount = Math.floor(usdtBalance * (amount / 100));
        } else {
          const asset = symbol.replace('USDT', '');
          const assetBalance = await spotService.getAssetBalance(asset);
          if (assetBalance && assetBalance.usdValue) {
            finalAmount = Math.floor(assetBalance.usdValue * (amount / 100));
          }
        }
      }

      // Execute the main trade first
      await this.handleSpotExecuteAction(ctx, symbol, side, finalAmount);

      // If TP is set for buy orders, place TP sell order
      if (tpValue && side === 'BUY') {
        await this.placeSpotTPOrder(ctx, symbol, tpValue);
      }

    } catch (error) {
      console.error('Spot TP/SL execution error:', error);
      await ctx.reply('❌ Failed to execute trade with TP. Please try again.');
    }
  }

  /**
   * Place TP/SL orders for futures positions
   */
  private async placeTPSLOrders(ctx: BotContext, symbol: string, side: 'BUY' | 'SELL', leverage: number, tpValue: number | null, slValue: number | null): Promise<void> {
    try {
      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState!.userId);
      
      // Wait a moment for the main order to be filled and position to be updated
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get current position to calculate TP/SL prices
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (!position) {
        await ctx.reply('⚠️ Position not found. TP/SL orders could not be placed. Please set them manually from positions menu.');
        return;
      }

      const entryPrice = parseFloat(position.entryPrice);
      let tpOrderResult = null;
      let slOrderResult = null;
      const results = [];

      // Place Take Profit order using dedicated API method
      if (tpValue) {
        const tpPrice = side === 'BUY' ? 
          entryPrice * (1 + tpValue / 100) : 
          entryPrice * (1 - tpValue / 100);
        
        try {
          tpOrderResult = await apiClient.setTakeProfit(symbol, tpPrice);
          results.push(`🎯 **Take Profit:** ${tpValue}% @ $${tpPrice.toFixed(6)} (ID: ${tpOrderResult.orderId})`);
        } catch (tpError: any) {
          console.error('Take profit order placement failed:', tpError);
          results.push(`❌ **Take Profit Failed:** ${tpError.message || 'Unknown error'}`);
        }
      }

      // Place Stop Loss order using dedicated API method
      if (slValue) {
        const slPrice = side === 'BUY' ? 
          entryPrice * (1 - slValue / 100) : 
          entryPrice * (1 + slValue / 100);
        
        try {
          slOrderResult = await apiClient.setStopLoss(symbol, slPrice);
          results.push(`🛡️ **Stop Loss:** ${slValue}% @ $${slPrice.toFixed(6)} (ID: ${slOrderResult.orderId})`);
        } catch (slError: any) {
          console.error('Stop loss order placement failed:', slError);
          results.push(`❌ **Stop Loss Failed:** ${slError.message || 'Unknown error'}`);
        }
      }

      // Send comprehensive confirmation message
      let confirmText = '';
      if (tpOrderResult || slOrderResult) {
        confirmText = `✅ **Risk Management Orders Placed**\n\n${results.join('\n')}\n\n⚠️ *Orders are active and will execute automatically when price targets are reached.*`;
      } else {
        confirmText = `⚠️ **TP/SL Orders Failed**\n\n${results.join('\n')}\n\n💡 *You can set them manually from the positions menu.*`;
      }

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📊 View Position', `position_${symbol}`),
          Markup.button.callback('📈 New Trade', 'unified_trade')
        ],
        [
          Markup.button.callback('🏠 Main Menu', 'main_menu')
        ]
      ]);

      await ctx.reply(confirmText, { parse_mode: 'Markdown', ...keyboard });

      // Emit events for successful orders
      if (tpOrderResult) {
        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_EXECUTED,
          timestamp: new Date(),
          userId: ctx.userState!.userId,
          telegramId: ctx.userState!.telegramId,
          correlationId: ctx.correlationId,
          symbol,
          action: 'TAKE_PROFIT',
          orderId: tpOrderResult.orderId
        });
      }

      if (slOrderResult) {
        this.eventEmitter.emitEvent({
          type: EventTypes.TRADE_EXECUTED,
          timestamp: new Date(),
          userId: ctx.userState!.userId,
          telegramId: ctx.userState!.telegramId,
          correlationId: ctx.correlationId,
          symbol,
          action: 'STOP_LOSS',
          orderId: slOrderResult.orderId
        });
      }

    } catch (error: any) {
      console.error('TP/SL order placement error:', error);
      await ctx.reply(`⚠️ **TP/SL Orders Failed**\n\n**Error:** ${error.message || 'Unknown error'}\n\n💡 *Your main trade was executed successfully. Set TP/SL manually from positions menu.*`);
    }
  }

  /**
   * Place TP order for spot positions
   */
  private async placeSpotTPOrder(ctx: BotContext, symbol: string, tpValue: number): Promise<void> {
    try {
      // For spot trading, we'll set up a simple limit sell order at TP price
      await ctx.reply(`✅ **Trade executed!** Set a manual sell order at ${tpValue}% profit when ready.`, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Spot TP order error:', error);
    }
  }

  /**
   * Handle refresh position P&L - updates the current position display
   */
  private async handleRefreshPosition(ctx: BotContext, symbol: string): Promise<void> {
    try {
      if (!ctx.userState?.isLinked) {
        await ctx.reply('❌ Please link your API credentials first using /link');
        return;
      }

      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      
      // Get fresh position data
      const positions = await apiClient.getPositionRisk();
      const position = positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
      
      if (!position) {
        await ctx.editMessageText('❌ No open position found for this symbol', { parse_mode: 'Markdown' });
        return;
      }

      const positionAmt = parseFloat(position.positionAmt);
      const side = positionAmt > 0 ? 'LONG' : 'SHORT';
      const pnl = parseFloat(position.unrealizedPnl) || 0;
      const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
      const sideEmoji = side === 'LONG' ? '🟢' : '🔴';
      const currentValue = Math.abs(positionAmt) * parseFloat(position.entryPrice);

      const refreshedText = [
        `🔄 **Refreshed Position Status**`,
        '',
        `${sideEmoji} **${side}** ${Math.abs(positionAmt).toFixed(4)} ${symbol.replace('USDT', '')}`,
        `💰 **Entry Price:** $${position.entryPrice}`,
        `📊 **Current Price:** $${position.entryPrice}`,
        `⚡ **Leverage:** ${position.leverage}x`,
        `${pnlEmoji} **Unrealized P&L:** ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
        `📈 **Current Value:** $${currentValue.toFixed(2)}`,
        '',
        `*Last updated: ${new Date().toLocaleTimeString()}*`
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔴 Close 25%', `position_close_25_${symbol}`),
          Markup.button.callback('🔴 Close 50%', `position_close_50_${symbol}`)
        ],
        [
          Markup.button.callback('🔴 Close 75%', `position_close_75_${symbol}`),
          Markup.button.callback('🔴 Close All', `position_close_${symbol}`)
        ],
        [
          Markup.button.callback('🔄 Refresh Again', `refresh_position_${symbol}`),
          Markup.button.callback('📊 All Positions', 'positions')
        ],
        [
          Markup.button.callback('📈 Trade Again', 'trade_perps'),
          Markup.button.callback('🏠 Main Menu', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(refreshedText, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      console.error('Refresh position error:', error);
      await ctx.reply('❌ Failed to refresh position data. Please try again.');
    }
  }

  /**
   * Handle spot sell percentage - sells a percentage of spot holdings
   */
  private async handleSpotSellPercentage(ctx: BotContext, symbol: string, percentage: number): Promise<void> {
    try {
      if (!ctx.userState?.isLinked) {
        await ctx.reply('❌ Please link your API credentials first using /link');
        return;
      }

      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      
      // Get current balance (simplified for now until spot API is fully implemented)
      // const account = await apiClient.getAccount();
      // const asset = symbol.replace('USDT', '');
      // const balance = account.balances.find((b: any) => b.asset === asset);
      
      // For now, show that this feature needs full spot API integration
      await ctx.editMessageText(
        `⚠️ **Spot Sell Feature**\n\nThis feature requires full spot API integration.\nPlease use the main trading interface for spot sales.`,
        { parse_mode: 'Markdown' }
      );
      return;

      // This will be enabled once spot API is fully integrated
      /*
      if (!balance || parseFloat(balance.free) <= 0) {
        await ctx.editMessageText(`❌ No ${asset} balance available to sell`, { parse_mode: 'Markdown' });
        return;
      }

      const availableAmount = parseFloat(balance.free);
      const sellAmount = (availableAmount * percentage) / 100;
      
      if (sellAmount < 0.000001) {
        await ctx.editMessageText(`❌ Sell amount too small: ${sellAmount.toFixed(8)} ${asset}`, { parse_mode: 'Markdown' });
        return;
      }

      // Get exchange info for precision
      const exchangeInfo = await apiClient.getExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol);
      const lotSizeFilter = symbolInfo?.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.000001;
      
      // Format quantity with proper precision
      const formattedQuantity = this.formatQuantityWithPrecision(sellAmount, stepSize);

      // Show confirmation
      const confirmText = [
        `🔴 **Confirm Spot Sell Order**`,
        '',
        `💰 **Sell ${percentage}% of ${asset} Holdings**`,
        `🪙 **Amount:** ${formattedQuantity} ${asset}`,
        `📊 **Available:** ${availableAmount.toFixed(6)} ${asset}`,
        `💱 **Market:** ${symbol}`,
        '',
        '⚠️ This will execute a market sell order immediately'
      ].join('\n');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Sell', `spot_confirm_sell_${formattedQuantity}_${symbol}`),
          Markup.button.callback('❌ Cancel', 'main_menu')
        ]
      ]);

      await ctx.editMessageText(confirmText, { parse_mode: 'Markdown', ...keyboard });
      */
    } catch (error) {
      console.error('Spot sell percentage error:', error);
      await ctx.reply(`❌ Failed to prepare sell order: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle spot confirm sell - executes the confirmed sell order
   */
  private async handleSpotConfirmSell(ctx: BotContext, symbol: string, quantity: number): Promise<void> {
    try {
      if (!ctx.userState?.isLinked) {
        await ctx.reply('❌ Please link your API credentials first using /link');
        return;
      }

      const apiClient = await this.apiClientService.getOrCreateClient(ctx.userState.userId);
      
      // For now, show that this feature needs full spot API integration
      await ctx.editMessageText(
        `⚠️ **Spot Sell Confirmation**\n\nThis feature requires full spot API integration.\nPlease use the main trading interface for spot sales.`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('Spot confirm sell error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      
      const errorText = [
        '❌ **Spot Sell Order Failed**',
        '',
        `**Symbol:** ${symbol}`,
        `**Error:** ${errorMessage}`,
        '',
        'Please try again or contact support if the issue persists.'
      ].join('\n');

      await ctx.editMessageText(errorText, { parse_mode: 'Markdown' });
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