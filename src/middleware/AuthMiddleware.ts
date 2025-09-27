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

  constructor(db: DatabaseManager, eventEmitter: BotEventEmitter) {
    this.db = db;
    this.eventEmitter = eventEmitter;
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
        const existingConversationState = ctx.userState?.conversationState;
        ctx.userState = await this.loadUserState(telegramId);
        
        // Preserve conversation state if it exists
        if (existingConversationState && ctx.userState) {
          ctx.userState.conversationState = existingConversationState;
          console.log(`[Auth] Preserved conversation state: ${existingConversationState.step}`);
        }
        
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
   * Load user state from database
   */
  private async loadUserState(telegramId: number): Promise<UserState | undefined> {
    try {
      // Load from database - no caching for reliable data consistency
      let user = await this.db.getUserByTelegramId(telegramId);
      if (!user) {
        // Create new user
        user = await this.db.createUser(telegramId);
      }

      // Load additional data in parallel
      const [credentials, existingSettings] = await Promise.all([
        this.db.getApiCredentials(user.id),
        this.db.getUserSettings(user.id)
      ]);
      
      const settings = existingSettings || await this.db.createDefaultSettings(user.id);

      const userState: UserState = {
        userId: user.id,
        telegramId: user.tg_id,
        isLinked: !!credentials,
        settings,
        rateLimitRemaining: 100, // Default rate limit
        // Add other fields as needed
      };

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

}