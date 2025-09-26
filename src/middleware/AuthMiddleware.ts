import { Context, MiddlewareFn } from 'telegraf';
import { DatabaseManager } from '../db';
import { UserState } from '../types';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';

export interface BotContext extends Context {
  userState?: UserState;
  correlationId?: string;
}

export class AuthMiddleware {
  private db: DatabaseManager;
  private eventEmitter: BotEventEmitter;
  private userStateCache = new Map<number, UserState>();

  constructor(db: DatabaseManager, eventEmitter: BotEventEmitter) {
    this.db = db;
    this.eventEmitter = eventEmitter;
    
    // Clean up cache periodically
    setInterval(() => this.cleanupUserCache(), 10 * 60 * 1000); // 10 minutes
  }

  /**
   * Main authentication middleware
   */
  middleware(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      const startTime = Date.now();
      
      try {
        // Generate correlation ID for request tracking
        ctx.correlationId = this.generateCorrelationId();
        
        // Skip authentication for certain commands
        if (this.shouldSkipAuth(ctx)) {
          return next();
        }

        const telegramId = ctx.from?.id;
        if (!telegramId) {
          await ctx.reply('❌ Unable to identify user. Please try again.');
          return;
        }

        // Load or create user state
        ctx.userState = await this.loadUserState(telegramId);
        
        if (ctx.userState) {
          this.eventEmitter.emitEvent({
            type: EventTypes.USER_AUTHENTICATED,
            timestamp: new Date(),
            userId: ctx.userState.userId,
            telegramId: ctx.userState.telegramId,
            correlationId: ctx.correlationId
          });
        }

        console.log(`[Auth] User ${telegramId} authenticated in ${Date.now() - startTime}ms`);
        
        return next();
      } catch (error) {
        console.error('[Auth] Authentication error:', error);
        await ctx.reply('❌ Authentication failed. Please try again.');
      }
    };
  }

  /**
   * Middleware to ensure user has linked API credentials
   */
  requireLinkedAccount(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      if (!ctx.userState?.isLinked) {
        await ctx.reply('❌ Please link your API credentials first using /link');
        return;
      }
      return next();
    };
  }

  /**
   * Middleware for admin-only commands
   */
  requireAdmin(adminIds: number[]): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !adminIds.includes(userId)) {
        // Silently ignore for security
        return;
      }
      return next();
    };
  }

  /**
   * Load user state from database or cache
   */
  private async loadUserState(telegramId: number): Promise<UserState | undefined> {
    try {
      // Check cache first
      const cached = this.userStateCache.get(telegramId);
      if (cached && this.isCacheValid(cached)) {
        return cached;
      }

      // Load from database
      let user = await this.db.getUserByTelegramId(telegramId);
      if (!user) {
        // Create new user
        user = await this.db.createUser(telegramId);
      }

      // Load additional data
      const credentials = await this.db.getApiCredentials(user.id);
      const settings = await this.db.getUserSettings(user.id) || 
                      await this.db.createDefaultSettings(user.id);

      const userState: UserState = {
        userId: user.id,
        telegramId: user.tg_id,
        isLinked: !!credentials,
        settings,
        rateLimitRemaining: 100, // Default rate limit
        // Add other fields as needed
      };

      // Cache the user state
      this.userStateCache.set(telegramId, {
        ...userState,
        lastUpdated: new Date()
      } as UserState & { lastUpdated: Date });

      return userState;
    } catch (error) {
      console.error('[Auth] Failed to load user state:', error);
      return undefined;
    }
  }

  /**
   * Check if we should skip authentication for certain commands
   */
  private shouldSkipAuth(ctx: Context): boolean {
    const text = 'message' in ctx.update && 'text' in ctx.update.message 
      ? ctx.update.message.text 
      : '';
    
    const skipCommands = ['/start', '/help'];
    return skipCommands.some(cmd => text?.startsWith(cmd));
  }

  /**
   * Generate unique correlation ID for request tracking
   */
  private generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if cached user state is still valid
   */
  private isCacheValid(userState: UserState & { lastUpdated?: Date }): boolean {
    if (!userState.lastUpdated) return false;
    
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const age = Date.now() - userState.lastUpdated.getTime();
    return age < maxAge;
  }

  /**
   * Clean up expired user state cache
   */
  private cleanupUserCache(): void {
    const now = Date.now();
    const maxAge = 15 * 60 * 1000; // 15 minutes
    
    for (const [telegramId, userState] of this.userStateCache.entries()) {
      const lastUpdated = (userState as any).lastUpdated as Date;
      if (lastUpdated && now - lastUpdated.getTime() > maxAge) {
        this.userStateCache.delete(telegramId);
      }
    }
  }

  /**
   * Invalidate user cache (e.g., when user links/unlinks account)
   */
  invalidateUserCache(telegramId: number): void {
    this.userStateCache.delete(telegramId);
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): { size: number; hitRate?: number } {
    return {
      size: this.userStateCache.size
      // Add hit rate tracking if needed
    };
  }
}