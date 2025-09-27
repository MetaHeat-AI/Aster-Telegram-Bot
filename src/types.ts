import { z } from 'zod';

// ========== Database Types ==========

export interface User {
  id: number;
  tg_id: number;
  created_at: Date;
}

export interface ApiCredentials {
  user_id: number;
  aster_key_enc: string;
  aster_secret_enc: string;
  created_at: Date;
  last_ok_at: Date | null;
}

export interface UserSettings {
  user_id: number;
  leverage_cap: number;
  default_leverage: number;
  size_presets: number[];
  slippage_bps: number;
  tp_presets: number[];
  sl_presets: number[];
  daily_loss_cap: number | null;
  pin_hash: string | null;
}


export interface Order {
  id?: number;
  user_id: number;
  client_order_id: string;
  side: 'BUY' | 'SELL';
  symbol: string;
  size: string;
  leverage: number;
  status: string;
  tx: string | null;
  created_at: Date;
}

// ========== Aster API Types ==========

export const OrderSideSchema = z.enum(['BUY', 'SELL']);
export const OrderTypeSchema = z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET']);
export const TimeInForceSchema = z.enum(['GTC', 'IOC', 'FOK', 'GTX']);
export const WorkingTypeSchema = z.enum(['MARK_PRICE', 'CONTRACT_PRICE']);

export interface ExchangeInfo {
  timezone: string;
  serverTime: number;
  rateLimits: RateLimit[];
  exchangeFilters: any[];
  symbols: SymbolInfo[];
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  baseAssetPrecision: number;
  quoteAsset: string;
  quotePrecision: number;
  quoteAssetPrecision: number;
  orderTypes: string[];
  timeInForce: string[];
  filters: SymbolFilter[];
  priceFilter?: PriceFilter;
  lotSizeFilter?: LotSizeFilter;
  marketLotSizeFilter?: MarketLotSizeFilter;
  minNotionalFilter?: MinNotionalFilter;
  percentPriceFilter?: PercentPriceFilter;
  maxNumOrdersFilter?: MaxNumOrdersFilter;
}

export interface SymbolFilter {
  filterType: string;
  [key: string]: any;
}

export interface PriceFilter {
  filterType: 'PRICE_FILTER';
  minPrice: string;
  maxPrice: string;
  tickSize: string;
}

export interface LotSizeFilter {
  filterType: 'LOT_SIZE';
  minQty: string;
  maxQty: string;
  stepSize: string;
}

export interface MarketLotSizeFilter {
  filterType: 'MARKET_LOT_SIZE';
  minQty: string;
  maxQty: string;
  stepSize: string;
}

export interface MinNotionalFilter {
  filterType: 'MIN_NOTIONAL';
  notional: string;
}

export interface PercentPriceFilter {
  filterType: 'PERCENT_PRICE';
  multiplierUp: string;
  multiplierDown: string;
  multiplierDecimal: string;
}

export interface MaxNumOrdersFilter {
  filterType: 'MAX_NUM_ORDERS';
  limit: number;
}

export interface RateLimit {
  rateLimitType: string;
  interval: string;
  intervalNum: number;
  limit: number;
}

export interface OrderBookDepth {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface AccountInfo {
  feeTier: number;
  canTrade: boolean;
  canDeposit: boolean;
  canWithdraw: boolean;
  updateTime: number;
  totalWalletBalance: string;
  totalUnrealizedPnl: string;
  totalMarginBalance: string;
  totalPositionInitialMargin: string;
  totalOpenOrderInitialMargin: string;
  totalCrossWalletBalance: string;
  totalCrossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: AssetInfo[];
  positions: PositionInfo[];
}

export interface AssetInfo {
  asset: string;
  walletBalance: string;
  unrealizedPnl: string;
  marginBalance: string;
  maintMargin: string;
  initialMargin: string;
  positionInitialMargin: string;
  openOrderInitialMargin: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
}

export interface PositionInfo {
  symbol: string;
  initialMargin: string;
  maintMargin: string;
  unrealizedPnl: string;
  positionInitialMargin: string;
  openOrderInitialMargin: string;
  leverage: string;
  isolated: boolean;
  entryPrice: string;
  maxNotional: string;
  positionSide: string;
  positionAmt: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
  bidNotional: string;
  askNotional: string;
}

export interface NewOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET';
  quantity?: string;
  quoteOrderQty?: string;
  price?: string;
  stopPrice?: string;
  closePosition?: boolean;
  activationPrice?: string;
  callbackRate?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
  reduceOnly?: boolean;
  newClientOrderId?: string;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  priceProtect?: boolean;
  newOrderRespType?: 'ACK' | 'RESULT';
  recvWindow?: number;
  timestamp: number;
  signature: string;
}

export interface OrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQty: string;
  cumQuote: string;
  timeInForce: string;
  type: string;
  reduceOnly: boolean;
  closePosition: boolean;
  side: string;
  positionSide: string;
  stopPrice: string;
  workingType: string;
  priceProtect: boolean;
  origType: string;
  updateTime: number;
}

// ========== User Stream Events ==========

export interface UserStreamEvent {
  e: string; // Event type
  E: number; // Event time
}

export interface AccountUpdateEvent extends UserStreamEvent {
  e: 'ACCOUNT_UPDATE';
  T: number; // Transaction time
  a: {
    m: string; // Event reason type
    B: AssetBalance[]; // Balances
    P: PositionUpdate[]; // Positions
  };
}

export interface AssetBalance {
  a: string; // Asset
  wb: string; // Wallet Balance
  cw: string; // Cross Wallet Balance
  bc: string; // Balance Change except PnL and Commission
}

export interface PositionUpdate {
  s: string; // Symbol
  pa: string; // Position Amount
  ep: string; // Entry Price
  cr: string; // (Pre-fee) Accumulated Realized
  up: string; // Unrealized PnL
  mt: string; // Margin Type
  iw: string; // Isolated Wallet (if isolated position)
  ps: string; // Position Side
}

export interface OrderTradeUpdateEvent extends UserStreamEvent {
  e: 'ORDER_TRADE_UPDATE';
  T: number; // Transaction time
  o: {
    s: string; // Symbol
    c: string; // Client Order ID
    S: string; // Side
    o: string; // Order Type
    f: string; // Time in Force
    q: string; // Original Quantity
    p: string; // Original Price
    ap: string; // Average Price
    sp: string; // Stop Price
    x: string; // Execution Type
    X: string; // Order Status
    i: number; // Order ID
    l: string; // Last Filled Quantity
    z: string; // Cumulative Filled Quantity
    L: string; // Last Filled Price
    N: string; // Commission Asset
    n: string; // Commission
    T: number; // Order Trade Time
    t: number; // Trade ID
    b: string; // Bids Notional
    a: string; // Ask Notional
    m: boolean; // Is this trade the maker side?
    R: boolean; // Is this reduce only
    wt: string; // Stop Price Working Type
    ot: string; // Original Order Type
    ps: string; // Position Side
    cp: boolean; // If Close-All
    AP: string; // Activation Price
    cr: string; // Callback Rate
    rp: string; // Realized Profit
  };
}

export interface MarginCallEvent extends UserStreamEvent {
  e: 'MARGIN_CALL';
  cw: string; // Cross Wallet Balance
  p: Array<{
    s: string; // Symbol
    ps: string; // Position Side
    pa: string; // Position Amount
    mt: string; // Margin Type
    iw: string; // Isolated Wallet (if isolated position)
    mp: string; // Mark Price
    up: string; // Unrealized PnL
    mm: string; // Maintenance Margin Required
  }>;
}

export interface AccountConfigUpdateEvent extends UserStreamEvent {
  e: 'ACCOUNT_CONFIG_UPDATE';
  T: number; // Transaction time
  ac: {
    s: string; // Symbol
    l: number; // Leverage
  } | null;
  ai: {
    j: boolean; // Multi-Assets Mode
  } | null;
}

// ========== Trade Parsing Types ==========

export interface TradeCommand {
  action: 'BUY' | 'SELL';
  symbol: string;
  size?: string;
  sizeType: 'BASE' | 'QUOTE'; // base = 0.25 ETH, quote = 100u
  leverage?: number;
  orderType?: 'MARKET' | 'LIMIT';
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
  trailing?: string;
  reduceOnly?: boolean;
}

export const TradeCommandSchema = z.object({
  action: z.enum(['BUY', 'SELL']),
  symbol: z.string(),
  size: z.string().optional(),
  sizeType: z.enum(['BASE', 'QUOTE']),
  leverage: z.number().min(1).max(20).optional(),
  orderType: z.enum(['MARKET', 'LIMIT']).optional(),
  price: z.string().optional(),
  stopLoss: z.string().optional(),
  takeProfit: z.string().optional(),
  trailing: z.string().optional(),
  reduceOnly: z.boolean().optional(),
});

export interface TradePreview {
  command: TradeCommand;
  symbol: string;
  side: 'BUY' | 'SELL';
  baseSize: string;
  quoteSize: string;
  leverage: number;
  estimatedPrice: string;
  estimatedFees: string;
  priceImpact?: string;
  slippageWarning?: boolean;
  maxSlippageExceeded?: boolean;
}

// ========== Bot State Types ==========

export interface UserState {
  userId: number;
  telegramId: number;
  isLinked: boolean;
  settings: UserSettings;
  currentCommand?: string;
  pendingTrade?: TradePreview;
  rateLimitRemaining?: number;
  dailyLossTracking?: {
    date: string;
    lossAmount: number;
    isBlocked: boolean;
  };
  conversationState?: {
    step: 'waiting_api_key' | 'waiting_api_secret' | 'waiting_pin' | 'confirming_unlink' | 'price' | 'amount' | 'waiting_custom_pair' | 'waiting_custom_amount';
    data?: {
      apiKey?: string;
      pendingAction?: 'link' | 'unlink';
      tradingType?: 'spot' | 'perps';
      action?: string;
      symbol?: string;
    };
    type?: 'expecting_stop_loss' | 'expecting_take_profit' | 'expecting_margin';
    symbol?: string;
    marginType?: 'add' | 'reduce';
  };
  // Legacy input handling properties (for backward compatibility)
  awaitingInput?: string | boolean;
  inputContext?: {
    type: string;
    direction?: string;
    data?: any;
  };
}

// ========== Error Types ==========

export interface ApiError {
  code: number;
  msg: string;
}

export interface BotError extends Error {
  code?: string;
  isRetryable?: boolean;
  rateLimitInfo?: {
    retryAfter: number;
    remaining: number;
  };
}

// ========== Configuration Types ==========

export interface BotConfig {
  telegram: {
    token: string;
    adminIds: number[];
  };
  aster: {
    baseUrl: string;
    defaultRecvWindow: number;
    maxLeverage: number;
  };
  database: {
    url: string;
  };
  redis?: {
    url: string;
  };
  encryption: {
    key: string;
  };
  server: {
    port: number;
  };
  webhook: {
    url: string;
    secretToken: string;
    path: string;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
}

export const BotConfigSchema = z.object({
  telegram: z.object({
    token: z.string(),
    adminIds: z.array(z.number()),
  }),
  aster: z.object({
    baseUrl: z.string().url(),
    defaultRecvWindow: z.number().default(5000),
    maxLeverage: z.number().default(20),
  }),
  database: z.object({
    url: z.string(),
  }),
  redis: z.object({
    url: z.string(),
  }).optional(),
  encryption: z.object({
    key: z.string().min(32),
  }),
  server: z.object({
    port: z.number().default(3000),
  }),
  webhook: z.object({
    url: z.string().url(),
    secretToken: z.string().min(32),
    path: z.string().default('/webhook'),
  }),
  rateLimit: z.object({
    windowMs: z.number().default(60000),
    maxRequests: z.number().default(100),
  }),
});

// ========== Utility Types ==========

export type SignedRequestParams = Record<string, string | number | boolean | undefined>;

export interface SignedRequest {
  url: string;
  params: SignedRequestParams;
  signature: string;
  timestamp: number;
  queryString: string; // Consistent serialization for both signing and sending
}