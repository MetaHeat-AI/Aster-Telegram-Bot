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
  private readonly DISABLE_CHANNEL_CHECK = process.env.DISABLE_CHANNEL_CHECK === 'true';

  constructor(db: DatabaseManager, eventEmitter: BotEventEmitter) {
    this.db = db;
    this.eventEmitter = eventEmitter;
    
    console.log(`[Auth] Channel gate configuration:`, {
      channelId: this.REQUIRED_CHANNEL_ID,
      disabled: this.DISABLE_CHANNEL_CHECK
    });
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

        // Handle group messages - only respond to direct mentions with greeting
        if (ctx.chat?.type !== 'private') {
          console.log(`[Auth] ${ctx.chat?.type} chat detected`);
          
          // Check if bot was mentioned directly
          const message = 'message' in ctx.update ? ctx.update.message : null;
          const botUsername = ctx.botInfo?.username;
          
          if (message && 'text' in message && botUsername) {
            const wasMentioned = message.text?.includes(`@${botUsername}`) || 
                               message.entities?.some(entity => 
                                 entity.type === 'mention' && 
                                 message.text?.substring(entity.offset, entity.offset + entity.length) === `@${botUsername}`
                               );
            
            if (wasMentioned) {
              await this.sendGroupGreeting(ctx);
            }
          }
          
          return; // Don't continue with normal auth flow
        }

        // Check channel membership and referral access (if configured)
        if (this.REQUIRED_CHANNEL_ID && !this.DISABLE_CHANNEL_CHECK) {
          console.log(`[Auth] Channel check enabled with ID: ${this.REQUIRED_CHANNEL_ID}`);
          const hasAccess = await this.checkChannelMembershipAndReferral(ctx);
          if (!hasAccess) {
            return; // Access denied message already sent
          }
        } else {
          console.log(`[Auth] Channel check disabled - REQUIRED_CHANNEL_ID: ${this.REQUIRED_CHANNEL_ID}, DISABLED: ${this.DISABLE_CHANNEL_CHECK}`);
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
   * Check if user is a member of the required channel and has referral access
   */
  private async checkChannelMembershipAndReferral(ctx: BotContext): Promise<boolean> {
    if (!ctx.from?.id) return false;

    // First check channel membership - all group members get access
    const isChannelMember = await this.checkChannelMembership(ctx);
    if (isChannelMember) {
      console.log(`[Auth] User ${ctx.from.id} is group member - access granted`);
      // Update user as group member in database
      await this.db.updateUserAdminStatus(ctx.from.id, false); // Mark as group member (not necessarily admin)
      
      // Check if they're also an admin and update accordingly
      const isAdmin = await this.checkIfGroupAdmin(ctx);
      if (isAdmin) {
        console.log(`[Auth] User ${ctx.from.id} is also an admin`);
      }
      
      return true; // All group members get access
    }

    // User is not in the group - check if they have referral access
    const hasReferralAccess = await this.checkReferralAccess(ctx.from.id);
    if (hasReferralAccess) {
      // User has valid referral but not in channel - prompt to join for full experience
      await this.sendJoinChannelMessage(ctx);
      return false;
    }

    // User has no group membership and no referral access
    await this.sendReferralRequiredMessage(ctx);
    return false;
  }

  /**
   * Check if user is a member of the required channel
   */
  private async checkChannelMembership(ctx: BotContext): Promise<boolean> {
    if (!ctx.from?.id) return false;

    console.log(`[Auth] Checking membership for user ${ctx.from.id} in channel ${this.REQUIRED_CHANNEL_ID}`);

    try {
      // Get chat member status
      const member = await ctx.telegram.getChatMember(this.REQUIRED_CHANNEL_ID, ctx.from.id);
      
      console.log(`[Auth] User ${ctx.from.id} status: ${member.status}`);
      
      // Check if user is an active member
      const validStatuses = ['creator', 'administrator', 'member'];
      const isValidMember = validStatuses.includes(member.status);
      
      if (!isValidMember) {
        console.log(`[Auth] User ${ctx.from.id} access denied - status: ${member.status}`);
        await this.sendAccessDeniedMessage(ctx);
        return false;
      }

      console.log(`[Auth] User ${ctx.from.id} verified as channel member with status: ${member.status}`);
      return true;
    } catch (error: any) {
      console.error('[Auth] Channel membership check failed:', error);
      console.error('[Auth] Error details:', {
        channelId: this.REQUIRED_CHANNEL_ID,
        userId: ctx.from.id,
        errorMessage: error.message,
        errorCode: error.code
      });
      
      // If API fails, show informative message
      await ctx.reply(
        '⚠️ **Access Verification Failed**\n\n' +
        `Debug Info: Channel ${this.REQUIRED_CHANNEL_ID}, User ${ctx.from.id}\n` +
        `Error: ${error.message}\n\n` +
        'Unable to verify your channel membership. Please try again in a moment.\n\n' +
        'If the problem persists, make sure you\'re a member of our StableSolid beta test group.',
        { parse_mode: 'Markdown' }
      );
      return false;
    }
  }

  /**
   * Send greeting message when mentioned in groups
   */
  private async sendGroupGreeting(ctx: BotContext): Promise<void> {
    const greetingText = [
      '👋 **Hey there!**',
      '',
      'I\'m **SolidState** - the first & fastest AsterDEX trading bot.',
      '',
      '🚀 **For trading access:** Message me privately @' + (ctx.botInfo?.username || 'this_bot'),
      '📊 **Features:** Spot & Perp trading, TP/SL, portfolio tracking',
      '🔒 **Secure:** Your keys, your control',
      '',
      '💬 *I only provide trading services in private chats to keep this group clean.*'
    ].join('\n');

    try {
      await ctx.reply(greetingText, { parse_mode: 'Markdown' });
      console.log(`[Auth] Sent group greeting in chat ${ctx.chat?.id}`);
    } catch (error) {
      console.error('[Auth] Failed to send group greeting:', error);
    }
  }

  /**
   * Check if user is an admin in the required channel
   */
  private async checkIfGroupAdmin(ctx: BotContext): Promise<boolean> {
    if (!ctx.from?.id) return false;

    try {
      const member = await ctx.telegram.getChatMember(this.REQUIRED_CHANNEL_ID, ctx.from.id);
      const isAdmin = ['creator', 'administrator'].includes(member.status);
      
      if (isAdmin) {
        // Update user record to mark as admin
        await this.db.updateUserAdminStatus(ctx.from.id, true);
        console.log(`[Auth] User ${ctx.from.id} is admin with status: ${member.status}`);
      }
      
      return isAdmin;
    } catch (error: any) {
      console.error('[Auth] Admin check failed:', error);
      return false;
    }
  }

  /**
   * Check if user has referral access (either was invited or has own code)
   * Note: Group membership is checked separately and grants automatic access
   */
  private async checkReferralAccess(telegramId: number): Promise<boolean> {
    try {
      const user = await this.db.getUserByTelegramId(telegramId);
      if (!user) return false;

      // Check if user has referral access:
      // 1. Was invited by someone (has invited_by)
      // 2. Has generated their own referral code (existing user)
      // Note: is_group_admin is not checked here as group membership is handled separately
      return user.invited_by !== null || user.referral_code !== null;
    } catch (error) {
      console.error('[Auth] Referral access check failed:', error);
      return false;
    }
  }

  /**
   * Send referral required message
   */
  private async sendReferralRequiredMessage(ctx: BotContext): Promise<void> {
    const referralText = [
      '🎫 **SolidState: Access Required**',
      '',
      'To access the trading terminal, you need either:',
      '',
      '👥 **Option 1: Join our beta group** (Instant access)',
      '• Join: https://t.me/+T4KTNlGT4dEwMzc9',
      '• All group members get automatic access',
      '',
      '🎟️ **Option 2: Use a referral code**',
      '• Get an invite code from an existing user',
      '• Use `/start SS_CODE_HERE` with your referral code',
      '',
      '💡 *Group membership = No referral code needed!*'
    ].join('\n');

    await ctx.reply(referralText, { parse_mode: 'Markdown' });
  }

  /**
   * Send join channel message for users with valid referral but not in channel
   */
  private async sendJoinChannelMessage(ctx: BotContext): Promise<void> {
    const joinChannelText = [
      '✅ **Referral Code Verified!**',
      '',
      'Your referral access has been confirmed.',
      '',
      '📱 **Recommended: Join our beta test group**',
      '• Get instant access without referral codes',
      '• Connect with other traders and get updates',
      '• Priority support and feature announcements',
      '',
      '🔗 **Join here:** https://t.me/+T4KTNlGT4dEwMzc9',
      '',
      '💡 *Group members get automatic bot access!*'
    ].join('\n');

    await ctx.reply(joinChannelText, { parse_mode: 'Markdown' });
  }

  /**
   * Send access denied message with StableSolid branding
   */
  private async sendAccessDeniedMessage(ctx: BotContext): Promise<void> {
    const accessDeniedText = [
      '⚠️ **SolidState: Entry Denied!**',
      '**Verification required**',
      '',
      'This beta is gated. Make sure you\'re a member of our beta test group.',
      '',
      'Follow & DM **x.com/stablesolid** to gain access and tap into the revenue stream.'
    ].join('\n');

    await ctx.reply(accessDeniedText, { parse_mode: 'Markdown' });
  }

  /**
   * Process referral code from /start command
   */
  async processReferralCode(telegramId: number, referralCode: string): Promise<{ success: boolean; message: string }> {
    try {
      // Validate referral code format
      if (!referralCode.startsWith('SS_')) {
        return {
          success: false,
          message: '❌ Invalid referral code format. Codes must start with SS_'
        };
      }

      // Check if referral code exists and is valid
      const referralCodeData = await this.db.getReferralCodeData(referralCode);
      if (!referralCodeData) {
        return {
          success: false,
          message: '❌ Invalid or expired referral code. Please check your code and try again.'
        };
      }

      // Get or create user
      let user = await this.db.getUserByTelegramId(telegramId);
      if (!user) {
        user = await this.db.createUser(telegramId);
      }

      // Check if user already has referral access
      if (user.invited_by !== null || user.referral_code !== null) {
        return {
          success: true,
          message: '✅ You already have access to the StableSolid trading terminal!'
        };
      }

      // Create referral relationship
      await this.db.createReferral(referralCode, user.id);

      console.log(`[Auth] User ${telegramId} successfully used referral code ${referralCode}`);

      return {
        success: true,
        message: [
          '🎉 **Welcome to SolidState!**',
          '',
          '✅ Your referral code has been validated',
          '🚀 You now have access to the trading terminal',
          '',
          '💡 **Next steps:**',
          '• Use /link to connect your AsterDEX API credentials',
          '• Join our beta test group for updates',
          '• Start trading with /buy or /sell commands',
          '',
          '📈 *Happy trading!*'
        ].join('\n')
      };
    } catch (error) {
      console.error('[Auth] Referral code processing failed:', error);
      return {
        success: false,
        message: '❌ Failed to process referral code. Please try again later.'
      };
    }
  }

  /**
   * Generate unique correlation ID for request tracking
   */
  private generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

}