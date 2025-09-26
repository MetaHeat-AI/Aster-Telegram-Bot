import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import WebSocket from 'ws';
import { 
  ExchangeInfo, 
  OrderBookDepth, 
  AccountInfo, 
  NewOrderRequest, 
  OrderResponse, 
  ApiError, 
  BotError,
  UserStreamEvent,
  AccountUpdateEvent,
  OrderTradeUpdateEvent,
  MarginCallEvent,
  SymbolInfo,
  PositionInfo
} from './types';
import { AsterSigner } from './signing';

export class AsterApiClient {
  private axios: AxiosInstance;
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private exchangeInfo: ExchangeInfo | null = null;
  private symbolInfoCache = new Map<string, SymbolInfo>();
  private isMockMode: boolean;
  
  constructor(baseUrl: string, apiKey: string, apiSecret: string, mockMode = false) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.isMockMode = mockMode || process.env.MOCK === 'true';

    // Log mode with red banner
    if (this.isMockMode) {
      console.log('🔴 ==========================================');
      console.log('🔴 WARNING: MOCK MODE ENABLED - NO LIVE TRADES');
      console.log('🔴 ==========================================');
    } else {
      console.log('🟢 ==========================================');
      console.log('🟢 LIVE MODE ENABLED - REAL API CALLS');
      console.log('🟢 ==========================================');
    }
    
    this.axios = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AsterBot/1.0.0',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.axios.interceptors.request.use(
      (config) => {
        console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('[API] Request error:', error);
        return Promise.reject(error);
      }
    );

    this.axios.interceptors.response.use(
      (response) => {
        const rateLimitInfo = AsterSigner.extractRateLimitInfo(response.headers as Record<string, string>);
        if (AsterSigner.shouldBackoff(rateLimitInfo)) {
          console.warn('[API] Rate limit warning:', rateLimitInfo);
        }
        return response;
      },
      async (error: AxiosError) => {
        const apiError = this.handleApiError(error);
        
        if (apiError.code === 'RATE_LIMIT' && error.config) {
          const retryAfter = parseInt(error.response?.headers['retry-after'] || '1', 10) * 1000;
          const delay = Math.max(retryAfter, 1000);
          
          console.warn(`[API] Rate limited, retrying in ${delay}ms`);
          await this.sleep(delay);
          
          return this.axios.request(error.config);
        }
        
        return Promise.reject(apiError);
      }
    );
  }

  private handleApiError(error: AxiosError): BotError {
    const botError = new Error() as BotError;
    
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data as ApiError;
      
      botError.message = data?.msg || `API Error ${status}`;
      botError.code = this.mapStatusToCode(status);
      botError.isRetryable = status >= 500 || status === 429;
      
      if (status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '1', 10) * 1000;
        botError.rateLimitInfo = {
          retryAfter,
          remaining: 0,
        };
      }
    } else if (error.request) {
      botError.message = 'Network error - no response received';
      botError.code = 'NETWORK_ERROR';
      botError.isRetryable = true;
    } else {
      botError.message = error.message || 'Unknown API error';
      botError.code = 'UNKNOWN_ERROR';
      botError.isRetryable = false;
    }
    
    return botError;
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case 400: return 'BAD_REQUEST';
      case 401: return 'UNAUTHORIZED';
      case 403: return 'FORBIDDEN';
      case 404: return 'NOT_FOUND';
      case 418: return 'IP_BANNED';
      case 429: return 'RATE_LIMIT';
      case 500: return 'INTERNAL_SERVER_ERROR';
      case 502: return 'BAD_GATEWAY';
      case 503: return 'SERVICE_UNAVAILABLE';
      default: return `HTTP_${status}`;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getExchangeInfo(): Promise<ExchangeInfo> {
    if (this.exchangeInfo) {
      return this.exchangeInfo;
    }

    const response = await this.axios.get<ExchangeInfo>('/fapi/v1/exchangeInfo');
    this.exchangeInfo = response.data;
    
    this.exchangeInfo.symbols.forEach(symbol => {
      this.symbolInfoCache.set(symbol.symbol, symbol);
    });

    return this.exchangeInfo;
  }

  async getServerTime(): Promise<number> {
    const response = await this.axios.get<{ serverTime: number }>('/fapi/v1/time');
    return response.data.serverTime;
  }

  async syncServerTime(): Promise<void> {
    await AsterSigner.syncServerTime(this.baseUrl);
  }

  getSymbolInfo(symbol: string): SymbolInfo | undefined {
    return this.symbolInfoCache.get(symbol);
  }

  async getOrderBook(symbol: string, limit = 100): Promise<OrderBookDepth> {
    try {
      console.log(`[API] GET /fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
      const response = await this.axios.get<OrderBookDepth>('/fapi/v1/depth', {
        params: { symbol, limit }
      });
      return response.data;
    } catch (error) {
      console.error(`[API] Failed to get order book for ${symbol}:`, error);
      throw this.handleApiError(error as AxiosError);
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const signedRequest = AsterSigner.signGetRequest('/fapi/v1/account', {}, this.apiSecret);
    const response = await this.axios.get<AccountInfo>(signedRequest.url);
    return response.data;
  }

  async getPositionRisk(): Promise<PositionInfo[]> {
    const signedRequest = AsterSigner.signGetRequest('/fapi/v1/positionRisk', {}, this.apiSecret);
    const response = await this.axios.get<PositionInfo[]>(signedRequest.url);
    return response.data;
  }

  async changeLeverage(symbol: string, leverage: number): Promise<any> {
    try {
      const params = {
        symbol,
        leverage: leverage.toString(),
      };
      
      const signedRequest = AsterSigner.signPostRequest('/fapi/v1/leverage', params, this.apiSecret);
      const formData = new URLSearchParams(signedRequest.queryString);
      
      console.log(`[API] POST /fapi/v1/leverage`);
      const response = await this.axios.post('/fapi/v1/leverage', formData, {
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      console.log(`[API] Changed leverage for ${symbol} to ${leverage}x`);
      return response.data;
    } catch (error) {
      throw this.handleApiError(error as AxiosError);
    }
  }

  async createOrder(orderParams: Partial<NewOrderRequest>): Promise<OrderResponse> {
    if (!orderParams.symbol || !orderParams.side || !orderParams.type) {
      throw new Error('Missing required order parameters: symbol, side, type');
    }

    const clientOrderId = orderParams.newClientOrderId || AsterSigner.createClientOrderId();
    
    const params = {
      ...orderParams,
      newClientOrderId: clientOrderId,
      newOrderRespType: 'RESULT' as const,
    };

    const signedRequest = AsterSigner.signPostRequest('/fapi/v1/order', params, this.apiSecret);
    
    // Use the same query string that was signed to ensure consistency
    const formData = new URLSearchParams(signedRequest.queryString);

    const response = await this.axios.post<OrderResponse>('/fapi/v1/order', formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return response.data;
  }

  async cancelOrder(symbol: string, orderId?: number, clientOrderId?: string): Promise<OrderResponse> {
    if (!orderId && !clientOrderId) {
      throw new Error('Either orderId or clientOrderId must be provided');
    }

    const params: any = { symbol };
    if (orderId) params.orderId = orderId;
    if (clientOrderId) params.origClientOrderId = clientOrderId;

    const signedRequest = AsterSigner.signDeleteRequest('/fapi/v1/order', params, this.apiSecret);
    const response = await this.axios.delete<OrderResponse>(signedRequest.url);
    return response.data;
  }

  async cancelAllOrders(symbol?: string): Promise<{ code: number; msg: string }> {
    const params = symbol ? { symbol } : {};
    const signedRequest = AsterSigner.signDeleteRequest('/fapi/v1/allOpenOrders', params, this.apiSecret);
    const response = await this.axios.delete<{ code: number; msg: string }>(signedRequest.url);
    return response.data;
  }

  async closePosition(symbol: string, percentage: number = 100): Promise<OrderResponse> {
    const positions = await this.getPositionRisk();
    const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
    
    if (!position) {
      throw new Error(`No open position found for ${symbol}`);
    }

    const positionAmt = Math.abs(parseFloat(position.positionAmt));
    const closeQuantity = (positionAmt * percentage / 100).toString();
    const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

    const orderParams: Partial<NewOrderRequest> = {
      symbol,
      side: side as any,
      type: 'MARKET',
      quantity: closeQuantity,
      reduceOnly: true
    };

    return this.createOrder(orderParams);
  }

  async modifyPositionMargin(symbol: string, amount: number, type: 1 | 2 = 1): Promise<{ amount: number; code: number; msg: string; type: number }> {
    const params = {
      symbol,
      amount: amount.toString(),
      type: type.toString()
    };

    const signedRequest = AsterSigner.signPostRequest('/fapi/v1/positionMargin', params, this.apiSecret);
    const response = await this.axios.post<{ amount: number; code: number; msg: string; type: number }>(signedRequest.url);
    return response.data;
  }

  async setStopLoss(symbol: string, stopPrice: number, percentage?: number): Promise<OrderResponse> {
    const positions = await this.getPositionRisk();
    const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
    
    if (!position) {
      throw new Error(`No open position found for ${symbol}`);
    }

    const positionAmt = Math.abs(parseFloat(position.positionAmt));
    const quantity = percentage ? (positionAmt * percentage / 100).toString() : position.positionAmt;
    const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

    const orderParams: Partial<NewOrderRequest> = {
      symbol,
      side: side as any,
      type: 'STOP_MARKET',
      quantity: Math.abs(parseFloat(quantity)).toString(),
      stopPrice: stopPrice.toString(),
      reduceOnly: true
    };

    return this.createOrder(orderParams);
  }

  async setTakeProfit(symbol: string, price: number, percentage?: number): Promise<OrderResponse> {
    const positions = await this.getPositionRisk();
    const position = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
    
    if (!position) {
      throw new Error(`No open position found for ${symbol}`);
    }

    const positionAmt = Math.abs(parseFloat(position.positionAmt));
    const quantity = percentage ? (positionAmt * percentage / 100).toString() : position.positionAmt;
    const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

    const orderParams: Partial<NewOrderRequest> = {
      symbol,
      side: side as any,
      type: 'TAKE_PROFIT_MARKET',
      quantity: Math.abs(parseFloat(quantity)).toString(),
      stopPrice: price.toString(),
      reduceOnly: true
    };

    return this.createOrder(orderParams);
  }

  async createListenKey(): Promise<{ listenKey: string }> {
    const response = await this.axios.post<{ listenKey: string }>('/fapi/v1/listenKey');
    return response.data;
  }

  async keepAliveListenKey(listenKey: string): Promise<void> {
    const signedRequest = AsterSigner.signPutRequest('/fapi/v1/listenKey', { listenKey }, this.apiSecret);
    await this.axios.put(signedRequest.url);
  }

  async deleteListenKey(listenKey: string): Promise<void> {
    const signedRequest = AsterSigner.signDeleteRequest('/fapi/v1/listenKey', { listenKey }, this.apiSecret);
    await this.axios.delete(signedRequest.url);
  }

  async get24hrTicker(symbol: string): Promise<{ 
    lastPrice: string; 
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    volume: string;
  }> {
    const response = await this.axios.get(`/fapi/v1/ticker/24hr?symbol=${symbol}`);
    return response.data;
  }

  async getAllFuturesTickers(): Promise<Array<{
    symbol: string;
    lastPrice: string;
    volume: string;
    quoteVolume: string;
    priceChangePercent: string;
  }>> {
    try {
      const response = await this.axios.get('/fapi/v1/ticker/24hr');
      return response.data;
    } catch (error) {
      console.error('[FUTURES API] Failed to get all tickers:', error);
      return [];
    }
  }

  async getAllSpotTickers(): Promise<Array<{
    symbol: string;
    lastPrice: string;
    volume: string;
    quoteVolume: string;
    priceChangePercent: string;
  }>> {
    const spotBaseUrl = 'https://sapi.asterdex.com';
    const spotAxios = axios.create({ 
      baseURL: spotBaseUrl,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    try {
      const response = await spotAxios.get('/api/v1/ticker/24hr');
      return response.data;
    } catch (error) {
      console.error('[SPOT API] Failed to get all tickers:', error);
      return [];
    }
  }

  async getMyTrades(symbol: string, limit = 500): Promise<any[]> {
    const params = { symbol, limit: limit.toString() };
    const signedRequest = AsterSigner.signGetRequest('/api/v3/myTrades', params, this.apiSecret);
    const response = await this.axios.get<any[]>(signedRequest.url);
    return response.data;
  }

  async getIncomeHistory(params: {
    symbol?: string;
    incomeType?: 'TRANSFER' | 'WELCOME_BONUS' | 'REALIZED_PNL' | 'FUNDING_FEE' | 'COMMISSION' | 'INSURANCE_CLEAR';
    startTime?: number;
    endTime?: number;
    limit?: number;
  } = {}): Promise<any[]> {
    const queryParams = {
      ...params,
      limit: params.limit?.toString() || '100'
    };
    const signedRequest = AsterSigner.signGetRequest('/fapi/v1/income', queryParams, this.apiSecret);
    const response = await this.axios.get<any[]>(signedRequest.url);
    return response.data;
  }

  async createSpotOrder(orderParams: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LOSS_LIMIT' | 'TAKE_PROFIT' | 'TAKE_PROFIT_LIMIT';
    quantity?: string;
    quoteOrderQty?: string;
    price?: string;
    stopPrice?: string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
  }): Promise<any> {
    // Validate symbol exists on spot exchange
    const isValidSymbol = await this.validateSpotSymbol(orderParams.symbol);
    if (!isValidSymbol) {
      // Get available symbols for better error message
      try {
        const exchangeInfo = await this.getSpotExchangeInfo();
        const availableSymbols = exchangeInfo.symbols?.map((s: any) => s.symbol).slice(0, 10) || [];
        throw new Error(`Symbol ${orderParams.symbol} is not available for spot trading. Available symbols include: ${availableSymbols.join(', ')}...`);
      } catch (error) {
        throw new Error(`Symbol ${orderParams.symbol} is not available for spot trading. Please check the symbol or use futures trading instead.`);
      }
    }
    
    // Use spot API base URL and endpoint
    const spotBaseUrl = 'https://sapi.asterdex.com';
    
    // Create proper request with signed parameters
    const signedRequest = AsterSigner.signPostRequest('/api/v1/order', orderParams, this.apiSecret);
    
    // Create axios instance for spot API
    const spotAxios = axios.create({ 
      baseURL: spotBaseUrl,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    console.log(`[SPOT API] Request URL: ${signedRequest.url}`);
    console.log(`[SPOT API] Request data: ${signedRequest.queryString}`);
    
    // For POST requests, send the signed data as form body
    const response = await spotAxios.post('/api/v1/order', signedRequest.queryString);
    return response.data;
  }

  async getSpotAccount(): Promise<{ balances: Array<{ asset: string; free: string; locked: string }> }> {
    // Use spot API base URL and endpoint
    const spotBaseUrl = 'https://sapi.asterdex.com';
    const signedRequest = AsterSigner.signGetRequest('/api/v1/account', {}, this.apiSecret);
    
    // Create axios instance for spot API
    const spotAxios = axios.create({ 
      baseURL: spotBaseUrl,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`[SPOT API] Account request URL: ${signedRequest.url}`);
    
    // For GET requests, the signed parameters are in the URL
    const response = await spotAxios.get<{ balances: Array<{ asset: string; free: string; locked: string }> }>(`/api/v1/account?${signedRequest.url.split('?')[1]}`);
    return response.data;
  }

  async getSpotExchangeInfo(): Promise<any> {
    // Get spot exchange info to validate symbols
    const spotBaseUrl = 'https://sapi.asterdex.com';
    const spotAxios = axios.create({ 
      baseURL: spotBaseUrl,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    });
    
    try {
      const response = await spotAxios.get('/api/v1/exchangeInfo');
      return response.data;
    } catch (error) {
      console.error('[SPOT API] Failed to get exchange info:', error);
      throw error;
    }
  }

  async validateSpotSymbol(symbol: string): Promise<boolean> {
    try {
      const exchangeInfo = await this.getSpotExchangeInfo();
      const symbols = exchangeInfo.symbols || [];
      return symbols.some((s: any) => s.symbol === symbol && s.status === 'TRADING');
    } catch (error) {
      console.error(`[SPOT API] Symbol validation failed for ${symbol}:`, error);
      return false;
    }
  }

  async testConnectivity(): Promise<boolean> {
    try {
      const response = await this.axios.get('/fapi/v1/ping');
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  async validateApiCredentials(): Promise<boolean> {
    try {
      await this.getAccountInfo();
      return true;
    } catch (error) {
      console.error('API credentials validation failed:', error);
      return false;
    }
  }

  async getMarkPrice(symbol?: string): Promise<Array<{ symbol: string; markPrice: string; time: number }>> {
    const params = symbol ? { symbol } : {};
    const response = await this.axios.get('/fapi/v1/premiumIndex', { params });
    return response.data;
  }

  async getFundingRate(symbol?: string): Promise<Array<{ symbol: string; fundingRate: string; fundingTime: number }>> {
    const params = symbol ? { symbol } : {};
    const response = await this.axios.get('/fapi/v1/fundingRate', { params });
    return response.data;
  }


  async getRecentTrades(symbol: string, limit = 500): Promise<Array<{
    id: number;
    price: string;
    qty: string;
    quoteQty: string;
    time: number;
    isBuyerMaker: boolean;
  }>> {
    const response = await this.axios.get('/fapi/v1/trades', {
      params: { symbol, limit }
    });
    return response.data;
  }

  isClockSynced(maxDrift = 1000): boolean {
    return AsterSigner.isClockDriftAcceptable(maxDrift);
  }

  getTimeDrift(): number {
    return AsterSigner.getTimeDrift();
  }
}

export class AsterWebSocketClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private listenKey: string;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private eventHandlers = new Map<string, Array<(event: any) => void>>();

  constructor(baseUrl: string, listenKey: string) {
    // Aster uses different subdomains: REST=fapi.asterdex.com, WS=fstream.asterdex.com
    if (baseUrl.includes('fapi.asterdex.com')) {
      this.baseUrl = 'wss://fstream.asterdex.com';
    } else {
      this.baseUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    }
    this.listenKey = listenKey;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = `${this.baseUrl}/fapi/v1/ws/${this.listenKey}`;
        console.log(`[WS] Connecting to ${wsUrl}`);
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.on('open', () => {
          console.log('[WS] Connected to user data stream');
          this.reconnectAttempts = 0;
          this.startKeepAlive();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const event = JSON.parse(data.toString()) as UserStreamEvent;
            this.handleEvent(event);
          } catch (error) {
            console.error('[WS] Failed to parse message:', error);
          }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[WS] Connection closed: ${code} ${reason.toString()}`);
          this.stopKeepAlive();
          
          if (!this.isReconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnect();
          }
        });

        this.ws.on('error', (error: Error) => {
          console.error('[WS] WebSocket error:', error);
          reject(error);
        });

        this.ws.on('ping', (data: Buffer) => {
          console.log('[WS] Received ping, sending pong');
          this.ws?.pong(data);
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }

  private async reconnect(): Promise<void> {
    if (this.isReconnecting) return;
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    const delay = AsterSigner.calculateBackoffDelay(this.reconnectAttempts, 1000);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    await this.sleep(delay);
    
    try {
      await this.connect();
      this.isReconnecting = false;
    } catch (error) {
      console.error('[WS] Reconnection failed:', error);
      this.isReconnecting = false;
      
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('[WS] Max reconnection attempts reached');
        this.emit('maxReconnectAttemptsReached');
      } else {
        setTimeout(() => this.reconnect(), 5000);
      }
    }
  }

  private handleEvent(event: UserStreamEvent): void {
    console.log(`[WS] Received event: ${event.e}`);
    
    this.emit('event', event);
    this.emit(event.e, event);
    
    switch (event.e) {
      case 'ACCOUNT_UPDATE':
        this.emit('accountUpdate', event as AccountUpdateEvent);
        break;
      case 'ORDER_TRADE_UPDATE':
        this.emit('orderTradeUpdate', event as OrderTradeUpdateEvent);
        break;
      case 'MARGIN_CALL':
        this.emit('marginCall', event as MarginCallEvent);
        break;
    }
  }

  private startKeepAlive(): void {
    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  on(event: string, handler: (event: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  off(event: string, handler: (event: any) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[WS] Error in event handler for ${event}:`, error);
        }
      });
    }
  }

  async close(): Promise<void> {
    this.stopKeepAlive();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getConnectionState(): string {
    if (!this.ws) return 'DISCONNECTED';
    
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'CONNECTED';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }
}