import crypto from 'crypto';
import { SignedRequestParams, SignedRequest } from './types';

export class AsterSigner {
  private static readonly RECV_WINDOW_DEFAULT = 5000;
  private static serverTimeOffset = 0;

  static setServerTimeOffset(offset: number): void {
    this.serverTimeOffset = offset;
  }

  static getServerTime(): number {
    return Date.now() + this.serverTimeOffset;
  }

  static createSignature(secret: string, queryString: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(queryString)
      .digest('hex');
  }

  static buildQueryString(params: SignedRequestParams): string {
    // Preserve the original parameter order as provided
    // Binance API expects parameters in the order they are provided, not alphabetically sorted
    const keys = Object.keys(params)
      .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '');
    
    const paramEntries = keys.map(key => {
      const value = params[key];
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    });
    
    return paramEntries.join('&');
  }

  static signRequest(
    method: string,
    endpoint: string,
    params: SignedRequestParams = {},
    apiSecret: string,
    recvWindow = this.RECV_WINDOW_DEFAULT
  ): SignedRequest {
    const timestamp = this.getServerTime();
    
    // Build parameters in correct order: original params, then timestamp, recvWindow
    const signedParams: SignedRequestParams = {};
    
    // Add original parameters first
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
        signedParams[key] = params[key];
      }
    });
    
    // Add timestamp and recvWindow 
    signedParams.timestamp = timestamp;
    signedParams.recvWindow = recvWindow;

    const queryString = this.buildQueryString(signedParams);
    const signature = this.createSignature(apiSecret, queryString);
    
    // Add signature as the very last parameter
    signedParams.signature = signature;

    // Create the final query string using the SAME order
    const finalQueryString = this.buildQueryString(signedParams);
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = method === 'GET' || method === 'DELETE' 
      ? `${endpoint}${separator}${finalQueryString}`
      : endpoint;

    return {
      url,
      params: signedParams,
      signature,
      timestamp,
      queryString: finalQueryString, // Provide consistent serialization
    };
  }

  static signGetRequest(
    endpoint: string,
    params: SignedRequestParams = {},
    apiSecret: string,
    recvWindow?: number
  ): SignedRequest {
    return this.signRequest('GET', endpoint, params, apiSecret, recvWindow);
  }

  static signPostRequest(
    endpoint: string,
    params: SignedRequestParams = {},
    apiSecret: string,
    recvWindow?: number
  ): SignedRequest {
    return this.signRequest('POST', endpoint, params, apiSecret, recvWindow);
  }

  static signDeleteRequest(
    endpoint: string,
    params: SignedRequestParams = {},
    apiSecret: string,
    recvWindow?: number
  ): SignedRequest {
    return this.signRequest('DELETE', endpoint, params, apiSecret, recvWindow);
  }

  static signPutRequest(
    endpoint: string,
    params: SignedRequestParams = {},
    apiSecret: string,
    recvWindow?: number
  ): SignedRequest {
    return this.signRequest('PUT', endpoint, params, apiSecret, recvWindow);
  }

  static validateTimestamp(timestamp: number, recvWindow = this.RECV_WINDOW_DEFAULT): boolean {
    const serverTime = this.getServerTime();
    const timeDiff = Math.abs(serverTime - timestamp);
    return timeDiff <= recvWindow;
  }

  static createClientOrderId(prefix = 'aster_bot'): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${random}`;
  }

  static extractRateLimitInfo(headers: Record<string, string>): {
    usedWeight: number;
    usedWeight1m: number;
    orderCount: number;
    orderCount10s: number;
    orderCount1m: number;
  } {
    return {
      usedWeight: parseInt(headers['x-mbx-used-weight'] || '0', 10),
      usedWeight1m: parseInt(headers['x-mbx-used-weight-1m'] || '0', 10),
      orderCount: parseInt(headers['x-mbx-order-count'] || '0', 10),
      orderCount10s: parseInt(headers['x-mbx-order-count-10s'] || '0', 10),
      orderCount1m: parseInt(headers['x-mbx-order-count-1m'] || '0', 10),
    };
  }

  static shouldBackoff(rateLimitInfo: ReturnType<typeof AsterSigner.extractRateLimitInfo>): boolean {
    const WEIGHT_THRESHOLD = 1000;
    const ORDER_COUNT_THRESHOLD_10S = 50;
    const ORDER_COUNT_THRESHOLD_1M = 1200;

    return (
      rateLimitInfo.usedWeight > WEIGHT_THRESHOLD ||
      rateLimitInfo.orderCount10s > ORDER_COUNT_THRESHOLD_10S ||
      rateLimitInfo.orderCount1m > ORDER_COUNT_THRESHOLD_1M
    );
  }

  static calculateBackoffDelay(retryCount: number, baseDelay = 1000): number {
    const jitter = Math.random() * 0.1 + 0.9;
    return Math.min(baseDelay * Math.pow(2, retryCount) * jitter, 30000);
  }

  static async syncServerTime(baseUrl: string): Promise<void> {
    try {
      const response = await fetch(`${baseUrl}/fapi/v1/time`);
      if (!response.ok) {
        throw new Error(`Failed to sync server time: ${response.status}`);
      }
      
      const data = await response.json() as { serverTime: number };
      const serverTime = data.serverTime;
      const clientTime = Date.now();
      
      this.serverTimeOffset = serverTime - clientTime;
      
      console.log(`Server time synced. Offset: ${this.serverTimeOffset}ms`);
    } catch (error) {
      console.error('Failed to sync server time:', error);
      this.serverTimeOffset = 0;
    }
  }

  static getTimeDrift(): number {
    return Math.abs(this.serverTimeOffset);
  }

  static isClockDriftAcceptable(maxDrift = 1000): boolean {
    return this.getTimeDrift() < maxDrift;
  }
}

export function testHmacSigning(): void {
  const testParams = {
    symbol: 'LTCBTC',
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: '1',
    price: '0.1',
    recvWindow: 5000,
    timestamp: 1499827319559,
  };

  const testSecret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const expectedSignature = 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71';

  const queryString = AsterSigner.buildQueryString(testParams);
  const signature = AsterSigner.createSignature(testSecret, queryString);

  console.log('Test Query String:', queryString);
  console.log('Generated Signature:', signature);
  console.log('Expected Signature:', expectedSignature);
  console.log('Signatures Match:', signature === expectedSignature);

  if (signature !== expectedSignature) {
    throw new Error('HMAC signature test failed!');
  }

  console.log('✅ HMAC signature test passed!');
}