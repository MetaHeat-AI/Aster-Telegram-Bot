import { AsterApiClient } from '../aster';
import { DatabaseManager } from '../db';
import { EncryptionManager } from '../encryption';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export interface ApiClientServiceConfig {
  baseUrl: string;
  defaultRecvWindow: number;
}

export class ApiClientService {
  private userSessions = new Map<number, AsterApiClient>();
  private db: DatabaseManager;
  private encryption: EncryptionManager;
  private config: ApiClientServiceConfig;
  private eventEmitter: BotEventEmitter;

  constructor(
    db: DatabaseManager,
    encryption: EncryptionManager,
    config: ApiClientServiceConfig,
    eventEmitter: BotEventEmitter
  ) {
    this.db = db;
    this.encryption = encryption;
    this.config = config;
    this.eventEmitter = eventEmitter;
    
    // Clean up expired sessions periodically
    setInterval(() => this.cleanupExpiredSessions(), 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Get or create an API client for a user
   * This is the main entry point for all API operations
   */
  async getOrCreateClient(userId: number): Promise<AsterApiClient> {
    const startTime = Date.now();
    
    try {
      // Check if we have a cached client
      let client = this.userSessions.get(userId);
      
      if (!client) {
        // Create new client from database credentials
        client = await this.createClientFromDatabase(userId);
        this.userSessions.set(userId, client);
        
        this.eventEmitter.emitEvent({
          type: EventTypes.API_CLIENT_CREATED,
          timestamp: new Date(),
          userId,
          telegramId: 0, // Will be updated by caller if available
          endpoint: 'client_creation',
          method: 'CREATE',
          success: true,
          duration: Date.now() - startTime
        });
      }
      
      // Validate client is still working
      if (!(await this.validateClient(client))) {
        // Recreate client if validation fails
        client = await this.createClientFromDatabase(userId);
        this.userSessions.set(userId, client);
      }
      
      return client;
    } catch (error) {
      this.eventEmitter.emitEvent({
        type: EventTypes.API_CALL_FAILED,
        timestamp: new Date(),
        userId,
        telegramId: 0,
        endpoint: 'client_creation',
        method: 'CREATE',
        success: false,
        duration: Date.now() - startTime
      });
      
      throw new Error(`Failed to create API client: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate that an API client is still working
   */
  async validateClient(client: AsterApiClient): Promise<boolean> {
    try {
      const isValid = await client.validateApiCredentials();
      return isValid;
    } catch (error) {
      console.warn('[ApiClientService] Client validation failed:', error);
      return false;
    }
  }

  /**
   * Remove a client from the cache (e.g., when credentials are revoked)
   */
  removeClient(userId: number): void {
    this.userSessions.delete(userId);
  }

  /**
   * Get client count for monitoring
   */
  getClientCount(): number {
    return this.userSessions.size;
  }

  /**
   * Create a new client from database credentials
   */
  private async createClientFromDatabase(userId: number): Promise<AsterApiClient> {
    const credentials = await this.db.getApiCredentials(userId);
    if (!credentials) {
      throw new Error('No API credentials found for user');
    }

    const apiKey = this.encryption.decrypt(credentials.aster_key_enc);
    const apiSecret = this.encryption.decrypt(credentials.aster_secret_enc);

    const client = new AsterApiClient(this.config.baseUrl, apiKey, apiSecret);
    
    // Test the credentials
    const isValid = await client.validateApiCredentials();
    if (!isValid) {
      throw new Error('Invalid API credentials');
    }

    // Update last successful connection
    await this.db.updateLastOkAt(userId);
    
    return client;
  }

  /**
   * Clean up clients that haven't been used recently
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    const now = Date.now();
    
    // Simple cleanup - in production you'd track last access time
    if (this.userSessions.size > 100) {
      console.log('[ApiClientService] Performing session cleanup');
      // Keep only the most recent sessions
      const entries = Array.from(this.userSessions.entries());
      this.userSessions.clear();
      
      // Keep the last 50 sessions
      entries.slice(-50).forEach(([userId, client]) => {
        this.userSessions.set(userId, client);
      });
    }
  }
}