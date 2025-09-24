import { Telegraf } from 'telegraf';
import { DatabaseManager } from './db';
import { AsterApiClient, AsterWebSocketClient } from './aster';
import { EncryptionManager } from './encryption';
import { 
  AccountUpdateEvent, 
  OrderTradeUpdateEvent, 
  MarginCallEvent,
  UserStreamEvent 
} from './types';

export interface NotificationSettings {
  orderFills: boolean;
  positionUpdates: boolean;
  marginCalls: boolean;
  fundingPayments: boolean;
  priceAlerts: boolean;
}

export class NotificationManager {
  private db: DatabaseManager;
  private bot?: Telegraf;
  private userStreams = new Map<number, AsterWebSocketClient>();
  private isRunning = false;
  private keepAliveInterval?: NodeJS.Timeout;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async start(bot: Telegraf): Promise<void> {
    this.bot = bot;
    this.isRunning = true;

    // Start keep-alive for listen keys
    this.startKeepAlive();

    // Initialize existing user streams
    await this.initializeUserStreams();

    console.log('[Notifications] Started');
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }

    // Close all user streams
    for (const [userId, stream] of this.userStreams) {
      await this.disconnectUserStream(userId);
    }

    console.log('[Notifications] Stopped');
  }

  async connectUserStream(userId: number): Promise<void> {
    if (this.userStreams.has(userId)) {
      console.log(`[Notifications] User ${userId} stream already connected`);
      return;
    }

    try {
      // Get user credentials
      const credentials = await this.db.getApiCredentials(userId);
      if (!credentials) {
        console.log(`[Notifications] No credentials for user ${userId}`);
        return;
      }

      // Decrypt credentials
      const encryption = new EncryptionManager(process.env.ENCRYPTION_KEY!);
      const apiKey = encryption.decrypt(credentials.aster_key_enc);
      const apiSecret = encryption.decrypt(credentials.aster_secret_enc);

      // Create API client
      const apiClient = new AsterApiClient(
        process.env.ASTER_BASE_URL || 'https://api.aster.exchange',
        apiKey,
        apiSecret
      );

      // Get or create listen key
      let session = await this.db.getSession(userId);
      let listenKey: string;

      if (!session || session.listen_key_expires_at < new Date()) {
        // Create new listen key
        const response = await apiClient.createListenKey();
        listenKey = response.listenKey;

        // Store session with 50-minute expiry (refresh before 60-minute limit)
        const expiresAt = new Date(Date.now() + 50 * 60 * 1000);
        await this.db.storeSession(userId, listenKey, expiresAt);
      } else {
        listenKey = session.listen_key;
      }

      // Create WebSocket client
      const wsClient = new AsterWebSocketClient(
        (process.env.ASTER_BASE_URL || 'https://api.aster.exchange').replace('https://', 'wss://'),
        listenKey
      );

      // Set up event handlers
      this.setupEventHandlers(wsClient, userId);

      // Connect
      await wsClient.connect();
      
      this.userStreams.set(userId, wsClient);
      console.log(`[Notifications] Connected user ${userId} stream`);

    } catch (error) {
      console.error(`[Notifications] Failed to connect user ${userId} stream:`, error);
    }
  }

  async disconnectUserStream(userId: number): Promise<void> {
    const stream = this.userStreams.get(userId);
    if (!stream) return;

    try {
      await stream.close();
      this.userStreams.delete(userId);
      console.log(`[Notifications] Disconnected user ${userId} stream`);
    } catch (error) {
      console.error(`[Notifications] Error disconnecting user ${userId} stream:`, error);
    }
  }

  private setupEventHandlers(wsClient: AsterWebSocketClient, userId: number): void {
    // Order trade updates (fills)
    wsClient.on('ORDER_TRADE_UPDATE', async (event: OrderTradeUpdateEvent) => {
      await this.handleOrderTradeUpdate(userId, event);
    });

    // Account updates (balance/position changes)
    wsClient.on('ACCOUNT_UPDATE', async (event: AccountUpdateEvent) => {
      await this.handleAccountUpdate(userId, event);
    });

    // Margin call warnings
    wsClient.on('MARGIN_CALL', async (event: MarginCallEvent) => {
      await this.handleMarginCall(userId, event);
    });

    // Connection issues
    wsClient.on('maxReconnectAttemptsReached', async () => {
      console.error(`[Notifications] User ${userId} stream failed to reconnect`);
      await this.sendNotification(userId, '🔴 **Connection Lost**\n\nFailed to reconnect to user data stream. Please restart the bot or contact support.');
      
      // Try to reconnect after delay
      setTimeout(() => {
        this.connectUserStream(userId).catch(console.error);
      }, 30000);
    });

    wsClient.on('error', (error) => {
      console.error(`[Notifications] User ${userId} stream error:`, error);
    });
  }

  private async handleOrderTradeUpdate(userId: number, event: OrderTradeUpdateEvent): Promise<void> {
    const order = event.o;
    
    // Only send notifications for executions and fills
    if (order.x !== 'TRADE') return;

    const side = order.S === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const executionType = order.X;
    
    let message = '';
    
    if (executionType === 'FILLED' || executionType === 'PARTIALLY_FILLED') {
      const emoji = executionType === 'FILLED' ? '✅' : '⏳';
      
      message = [
        `${emoji} **Order ${executionType}**`,
        '',
        `${side} ${order.s}`,
        `• Filled Qty: ${order.l}`,
        `• Fill Price: $${order.L}`,
        `• Total Filled: ${order.z}/${order.q}`,
        `• Order ID: \`${order.i}\``,
      ].join('\n');

      if (order.n && parseFloat(order.n) > 0) {
        message += `\n• Fee: ${order.n} ${order.N}`;
      }

      if (order.rp && parseFloat(order.rp) !== 0) {
        const pnlEmoji = parseFloat(order.rp) > 0 ? '📈' : '📉';
        message += `\n• ${pnlEmoji} Realized PnL: $${order.rp}`;
      }
    }

    if (message) {
      await this.sendNotification(userId, message);
    }

    // Update order status in database
    try {
      await this.db.storeOrder({
        user_id: userId,
        client_order_id: order.c,
        side: order.S as 'BUY' | 'SELL',
        symbol: order.s,
        size: order.q,
        leverage: 1, // Would need to be tracked separately
        status: order.X,
        tx: order.i.toString(),
      });
    } catch (error) {
      console.error('Failed to update order in database:', error);
    }
  }

  private async handleAccountUpdate(userId: number, event: AccountUpdateEvent): Promise<void> {
    const account = event.a;
    
    // Check for significant position changes
    if (account.P && account.P.length > 0) {
      for (const position of account.P) {
        const positionSize = parseFloat(position.pa);
        const unrealizedPnl = parseFloat(position.up);
        
        // Only notify for significant changes (this could be made configurable)
        if (Math.abs(unrealizedPnl) > 10) { // $10+ PnL change
          const side = positionSize > 0 ? '🟢 LONG' : '🔴 SHORT';
          const pnlEmoji = unrealizedPnl >= 0 ? '📈' : '📉';
          
          const message = [
            `📊 **Position Update**`,
            '',
            `${side} ${position.s}`,
            `• Size: ${Math.abs(positionSize)}`,
            `• Entry: $${position.ep}`,
            `• ${pnlEmoji} Unrealized PnL: $${unrealizedPnl.toFixed(2)}`,
          ].join('\n');

          await this.sendNotification(userId, message);
        }
      }
    }

    // Check for funding payments
    if (account.B && account.B.length > 0) {
      for (const balance of account.B) {
        const balanceChange = parseFloat(balance.bc);
        
        // Notify for significant balance changes (could be funding)
        if (Math.abs(balanceChange) > 0.01) {
          const changeEmoji = balanceChange > 0 ? '💰' : '💸';
          
          const message = [
            `${changeEmoji} **Balance Update**`,
            '',
            `• Asset: ${balance.a}`,
            `• Change: ${balanceChange > 0 ? '+' : ''}$${balanceChange.toFixed(4)}`,
            `• New Balance: $${balance.wb}`,
          ].join('\n');

          await this.sendNotification(userId, message);
        }
      }
    }
  }

  private async handleMarginCall(userId: number, event: MarginCallEvent): Promise<void> {
    const message = [
      '🚨 **MARGIN CALL WARNING**',
      '',
      `💰 Cross Wallet Balance: $${event.cw}`,
      '',
      '⚠️ **Positions at Risk:**',
    ];

    event.p.forEach(position => {
      const side = parseFloat(position.pa) > 0 ? 'LONG' : 'SHORT';
      message.push(`• ${side} ${position.s}: $${position.up} PnL`);
    });

    message.push('');
    message.push('🔴 **Action Required**: Add margin or reduce positions immediately!');

    await this.sendNotification(userId, message.join('\n'));
  }

  private async sendNotification(userId: number, message: string): Promise<void> {
    if (!this.bot) return;

    try {
      const user = await this.db.getUserById(userId);
      if (user) {
        await this.bot.telegram.sendMessage(
          user.tg_id,
          message,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error) {
      console.error(`Failed to send notification to user ${userId}:`, error);
    }
  }

  private async initializeUserStreams(): Promise<void> {
    try {
      // Get all users with valid credentials and recent activity
      const recentSessions = await this.db.getExpiredSessions();
      
      // For now, just connect streams for users with existing sessions
      // In production, you might want to be more selective about which users to connect
      const activeUsers = await this.getActiveUsers();
      
      for (const userId of activeUsers) {
        await this.connectUserStream(userId);
      }
      
    } catch (error) {
      console.error('[Notifications] Failed to initialize user streams:', error);
    }
  }

  private async getActiveUsers(): Promise<number[]> {
    // This is a placeholder implementation
    // In practice, you'd want to identify recently active users
    // For now, return empty array to avoid connecting to all users on startup
    return [];
  }

  private startKeepAlive(): void {
    // Refresh listen keys every 45 minutes
    this.keepAliveInterval = setInterval(async () => {
      if (!this.isRunning) return;

      console.log('[Notifications] Running keep-alive for listen keys');
      
      for (const [userId, stream] of this.userStreams) {
        try {
          // Get user credentials for API client
          const credentials = await this.db.getApiCredentials(userId);
          if (!credentials) continue;

          const encryption = new EncryptionManager(process.env.ENCRYPTION_KEY!);
          const apiKey = encryption.decrypt(credentials.aster_key_enc);
          const apiSecret = encryption.decrypt(credentials.aster_secret_enc);

          const apiClient = new AsterApiClient(
            process.env.ASTER_BASE_URL || 'https://api.aster.exchange',
            apiKey,
            apiSecret
          );

          // Get current session
          const session = await this.db.getSession(userId);
          if (session) {
            // Refresh the listen key
            await apiClient.keepAliveListenKey(session.listen_key);
            
            // Update expiry time
            const newExpiresAt = new Date(Date.now() + 50 * 60 * 1000);
            await this.db.storeSession(userId, session.listen_key, newExpiresAt);
            
            console.log(`[Notifications] Refreshed listen key for user ${userId}`);
          }

        } catch (error) {
          console.error(`[Notifications] Failed to refresh listen key for user ${userId}:`, error);
          
          // Try to reconnect the stream
          await this.disconnectUserStream(userId);
          setTimeout(() => {
            this.connectUserStream(userId).catch(console.error);
          }, 5000);
        }
      }
    }, 45 * 60 * 1000); // 45 minutes
  }

  // Public methods for managing user streams

  async enableNotifications(userId: number): Promise<void> {
    await this.connectUserStream(userId);
  }

  async disableNotifications(userId: number): Promise<void> {
    await this.disconnectUserStream(userId);
  }

  isUserConnected(userId: number): boolean {
    const stream = this.userStreams.get(userId);
    return stream ? stream.isConnected() : false;
  }

  getUserStreamStatus(userId: number): string {
    const stream = this.userStreams.get(userId);
    return stream ? stream.getConnectionState() : 'DISCONNECTED';
  }

  getConnectedUsersCount(): number {
    return this.userStreams.size;
  }

  // Send custom notifications
  async sendCustomNotification(userId: number, title: string, message: string): Promise<void> {
    const fullMessage = [
      `📢 **${title}**`,
      '',
      message,
    ].join('\n');

    await this.sendNotification(userId, fullMessage);
  }

  // Broadcast to all connected users (admin function)
  async broadcastNotification(title: string, message: string, adminOnly = false): Promise<void> {
    const fullMessage = [
      `📢 **${title}**`,
      '',
      message,
    ].join('\n');

    for (const userId of this.userStreams.keys()) {
      try {
        if (adminOnly) {
          // Check if user is admin (would need admin user tracking)
          continue;
        }
        
        await this.sendNotification(userId, fullMessage);
      } catch (error) {
        console.error(`Failed to broadcast to user ${userId}:`, error);
      }
    }
  }

  // Price alert functionality (future enhancement)
  async createPriceAlert(
    userId: number,
    symbol: string,
    targetPrice: number,
    condition: 'above' | 'below'
  ): Promise<void> {
    // Store price alert in database and check periodically
    // This would require additional database tables and background monitoring
    console.log(`Price alert created: ${symbol} ${condition} $${targetPrice} for user ${userId}`);
  }
}