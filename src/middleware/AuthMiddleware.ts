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
  private readonly REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID || '';

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

        // Check channel membership first (if configured)
        if (this.REQUIRED_CHANNEL_ID && !(await this.checkChannelMembership(ctx))) {
          return; // Access denied message already sent
        }

        const telegramId = ctx.from?.id;
        if (!telegramId) {
          await ctx.reply('❌ Unable to identify user. Please try again.');
          return;
        }

        // Load or create user state
        ctx.userState = await this.loadUserState(telegramId);
        
        // Restore conversation state from database
        if (ctx.userState) {
          const storedConversationState = await this.db.getConversationState(ctx.userState.userId);
          if (storedConversationState) {
            ctx.userState.conversationState = storedConversationState;
            console.log(`[Auth] Restored conversation state: ${storedConversationState.step}`);
          } else {
            console.log(`[Auth] No stored conversation state for user ${telegramId}`);
          }
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
   * Store conversation state in database
   */
  async setConversationState(telegramId: number, conversationState: any): Promise<void> {
    try {
      const user = await this.db.getUserByTelegramId(telegramId);
      if (user) {
        await this.db.setConversationState(user.id, conversationState, 10); // 10 minutes TTL
        console.log(`[Auth] Stored conversation state for user ${telegramId}: ${conversationState.step}`);
      }
    } catch (error) {
      console.error(`[Auth] Failed to store conversation state for user ${telegramId}:`, error);
    }
  }

  /**
   * Clear conversation state from database
   */
  async clearConversationState(telegramId: number): Promise<void> {
    try {
      const user = await this.db.getUserByTelegramId(telegramId);
      if (user) {
        await this.db.deleteConversationState(user.id);
        console.log(`[Auth] Cleared conversation state for user ${telegramId}`);
      }
    } catch (error) {
      console.error(`[Auth] Failed to clear conversation state for user ${telegramId}:`, error);
    }
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
   * Check if user is a member of the required channel
   */
  private async checkChannelMembership(ctx: BotContext): Promise<boolean> {
    if (!ctx.from?.id) return false;

    try {
      // Get chat member status
      const member = await ctx.telegram.getChatMember(this.REQUIRED_CHANNEL_ID, ctx.from.id);
      
      // Check if user is an active member
      const validStatuses = ['creator', 'administrator', 'member'];
      const isValidMember = validStatuses.includes(member.status);
      
      if (!isValidMember) {
        await this.sendAccessDeniedMessage(ctx);
        return false;
      }

      console.log(`[Auth] User ${ctx.from.id} verified as channel member`);
      return true;
    } catch (error) {
      console.error('[Auth] Channel membership check failed:', error);
      
      // If API fails, show informative message
      await ctx.reply(
        '⚠️ **Access Verification Failed**\n\n' +
        'Unable to verify your channel membership. Please try again in a moment.\n\n' +
        'If the problem persists, make sure you\'re a member of our StableSolid beta test group.',
        { parse_mode: 'Markdown' }
      );
      return false;
    }
  }

  /**
   * Send access denied message with channel join instructions
   */
  private async sendAccessDeniedMessage(ctx: BotContext): Promise<void> {
    const accessDeniedText = [
      '🔒 **Access Required**',
      '',
      'To use this bot, you need to be a member of our beta test group.',
      '',
      '**How to get access:**',
      '1. Join our StableSolid beta test group',
      '2. Use this invite link: https://t.me/+T4KTNlGT4dEwMzc9',
      '3. Come back and try the bot again',
      '',
      '💡 **Why?** This ensures beta testers get important updates and can provide feedback.',
      '',
      '🔄 After joining, type /start to begin!'
    ].join('\n');

    await ctx.reply(accessDeniedText, { parse_mode: 'Markdown' });
  }

  /**
   * Generate unique correlation ID for request tracking
   */
  private generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

}