import { AsterApiClient } from '../aster';
import { DatabaseManager } from '../db';
import { EncryptionManager } from '../encryption';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export interface ApiClientServiceConfig {
  baseUrl: string;
  defaultRecvWindow: number;
}

export class ApiClientService {
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
  }

  /**
   * Get or create an API client for a user
   * This is the main entry point for all API operations
   */
  async getOrCreateClient(userId: number): Promise<AsterApiClient> {
    const startTime = Date.now();
    
    try {
      // Create fresh client from database credentials
      const client = await this.createClientFromDatabase(userId);
      
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

}