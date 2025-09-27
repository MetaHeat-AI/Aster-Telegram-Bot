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
  private conversationStates: Map<number, any> = new Map(); // Temporary conversation state storage

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
        ctx.userState = await this.loadUserState(telegramId);
        
        // Restore conversation state from temporary storage
        const storedConversationState = this.conversationStates.get(telegramId);
        if (storedConversationState && ctx.userState) {
          ctx.userState.conversationState = storedConversationState;
          console.log(`[Auth] Restored conversation state: ${storedConversationState.step}`);
        } else {
          console.log(`[Auth] No stored conversation state for user ${telegramId}`);
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
   * Store conversation state temporarily
   */
  setConversationState(telegramId: number, conversationState: any): void {
    this.conversationStates.set(telegramId, conversationState);
    console.log(`[Auth] Stored conversation state for user ${telegramId}: ${conversationState.step}`);
    
    // Auto-cleanup after 10 minutes to prevent memory leaks
    setTimeout(() => {
      this.conversationStates.delete(telegramId);
      console.log(`[Auth] Auto-cleaned conversation state for user ${telegramId}`);
    }, 10 * 60 * 1000);
  }

  /**
   * Clear conversation state
   */
  clearConversationState(telegramId: number): void {
    this.conversationStates.delete(telegramId);
    console.log(`[Auth] Cleared conversation state for user ${telegramId}`);
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