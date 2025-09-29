import { Pool, PoolClient, QueryResult } from 'pg';
import { 
  User, 
  ApiCredentials, 
  UserSettings, 
 
  Order 
} from './types';

export class DatabaseManager {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });


    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.pool.on('connect', () => {
      console.log('[DB] Connected to PostgreSQL');
    });

    this.pool.on('error', (err) => {
      console.error('[DB] PostgreSQL error:', err);
    });
  }

  async connect(): Promise<void> {
    try {
      console.log('[Redis] Not configured, skipping Redis connection');
      await this.pool.connect();
      console.log('[DB] Database connections established');
    } catch (error) {
      console.error('[DB] Failed to connect:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.pool.end();
      console.log('[DB] Database connections closed');
    } catch (error) {
      console.error('[DB] Error disconnecting:', error);
    }
  }

  async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Create users table
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          tg_id BIGINT UNIQUE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id);
      `);

      // Create api_credentials table
      await client.query(`
        CREATE TABLE IF NOT EXISTS api_credentials (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          aster_key_enc TEXT NOT NULL,
          aster_secret_enc TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          last_ok_at TIMESTAMP WITH TIME ZONE,
          UNIQUE(user_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_api_credentials_user_id ON api_credentials(user_id);
      `);

      // Create settings table
      await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          leverage_cap INTEGER DEFAULT 20,
          default_leverage INTEGER DEFAULT 3,
          size_presets JSONB DEFAULT '[50, 100, 250]',
          slippage_bps INTEGER DEFAULT 50,
          tp_presets JSONB DEFAULT '[2, 4, 8]',
          sl_presets JSONB DEFAULT '[1, 2]',
          daily_loss_cap DECIMAL(18,8),
          pin_hash TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(user_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);
      `);


      // Create orders table
      await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          client_order_id TEXT NOT NULL,
          side VARCHAR(10) NOT NULL,
          symbol VARCHAR(20) NOT NULL,
          size DECIMAL(18,8) NOT NULL,
          leverage INTEGER NOT NULL,
          status VARCHAR(20) NOT NULL,
          tx TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(user_id, client_order_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id);
        CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
      `);

      // Create daily_loss_tracking table
      await client.query(`
        CREATE TABLE IF NOT EXISTS daily_loss_tracking (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          loss_amount DECIMAL(18,8) DEFAULT 0,
          is_blocked BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(user_id, date)
        );
        
        CREATE INDEX IF NOT EXISTS idx_daily_loss_user_date ON daily_loss_tracking(user_id, date);
      `);

      // Create conversation_states table
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_states (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
          step VARCHAR(50) NOT NULL,
          data JSONB,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_conversation_states_expires_at ON conversation_states(expires_at);
        CREATE INDEX IF NOT EXISTS idx_conversation_states_user_id ON conversation_states(user_id);
      `);

      // Add referral columns to users table
      await client.query(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS referral_code VARCHAR(30) UNIQUE,
        ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES users(id),
        ADD COLUMN IF NOT EXISTS is_group_admin BOOLEAN DEFAULT FALSE;
        
        CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
        CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);
      `);

      // Create referrals table
      await client.query(`
        CREATE TABLE IF NOT EXISTS referrals (
          id SERIAL PRIMARY KEY,
          referrer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          referee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          referral_code VARCHAR(30) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(referee_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
        CREATE INDEX IF NOT EXISTS idx_referrals_referral_code ON referrals(referral_code);
      `);

      await client.query('COMMIT');
      console.log('[DB] Database schema initialized successfully');
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[DB] Failed to initialize schema:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // ========== User Management ==========

  async createUser(telegramId: number): Promise<User> {
    const query = `
      INSERT INTO users (tg_id) 
      VALUES ($1) 
      ON CONFLICT (tg_id) DO UPDATE SET tg_id = EXCLUDED.tg_id
      RETURNING *
    `;
    
    const result = await this.pool.query(query, [telegramId]);
    return result.rows[0];
  }

  async getUserByTelegramId(telegramId: number): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE tg_id = $1';
    const result = await this.pool.query(query, [telegramId]);
    return result.rows[0] || null;
  }

  async getUserById(userId: number): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await this.pool.query(query, [userId]);
    return result.rows[0] || null;
  }

  // ========== API Credentials Management ==========

  async storeApiCredentials(userId: number, encryptedKey: string, encryptedSecret: string): Promise<void> {
    const query = `
      INSERT INTO api_credentials (user_id, aster_key_enc, aster_secret_enc) 
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        aster_key_enc = EXCLUDED.aster_key_enc,
        aster_secret_enc = EXCLUDED.aster_secret_enc,
        last_ok_at = NULL
    `;
    
    await this.pool.query(query, [userId, encryptedKey, encryptedSecret]);
  }

  async getApiCredentials(userId: number): Promise<ApiCredentials | null> {
    const query = 'SELECT * FROM api_credentials WHERE user_id = $1';
    const result = await this.pool.query(query, [userId]);
    return result.rows[0] || null;
  }

  async updateLastOkAt(userId: number): Promise<void> {
    const query = 'UPDATE api_credentials SET last_ok_at = NOW() WHERE user_id = $1';
    await this.pool.query(query, [userId]);
  }

  async removeApiCredentials(userId: number): Promise<void> {
    const query = 'DELETE FROM api_credentials WHERE user_id = $1';
    await this.pool.query(query, [userId]);
  }

  // ========== Settings Management ==========

  async createDefaultSettings(userId: number): Promise<UserSettings> {
    const query = `
      INSERT INTO settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      RETURNING *
    `;
    
    const result = await this.pool.query(query, [userId]);
    return result.rows[0] || await this.getUserSettings(userId);
  }

  async getUserSettings(userId: number): Promise<UserSettings | null> {
    const query = 'SELECT * FROM settings WHERE user_id = $1';
    const result = await this.pool.query(query, [userId]);
    return result.rows[0] || null;
  }

  async updateUserSettings(userId: number, settings: Partial<UserSettings>): Promise<void> {
    const setClause = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(settings)) {
      if (key !== 'user_id' && value !== undefined) {
        setClause.push(`${key} = $${paramIndex}`);
        values.push(typeof value === 'object' ? JSON.stringify(value) : value);
        paramIndex++;
      }
    }

    if (setClause.length === 0) return;

    setClause.push('updated_at = NOW()');
    values.push(userId);

    const query = `
      UPDATE settings 
      SET ${setClause.join(', ')}
      WHERE user_id = $${paramIndex}
    `;

    await this.pool.query(query, values);
  }


  // ========== Order Tracking ==========

  async storeOrder(order: Omit<Order, 'id' | 'created_at'>): Promise<void> {
    const query = `
      INSERT INTO orders (user_id, client_order_id, side, symbol, size, leverage, status, tx)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, client_order_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        tx = EXCLUDED.tx
    `;
    
    await this.pool.query(query, [
      order.user_id,
      order.client_order_id,
      order.side,
      order.symbol,
      order.size,
      order.leverage,
      order.status,
      order.tx
    ]);
  }

  async getOrderByClientId(userId: number, clientOrderId: string): Promise<Order | null> {
    const query = 'SELECT * FROM orders WHERE user_id = $1 AND client_order_id = $2';
    const result = await this.pool.query(query, [userId, clientOrderId]);
    return result.rows[0] || null;
  }

  async getUserOrders(userId: number, limit = 50): Promise<Order[]> {
    const query = `
      SELECT * FROM orders 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `;
    const result = await this.pool.query(query, [userId, limit]);
    return result.rows;
  }

  // ========== Daily Loss Tracking ==========

  async updateDailyLoss(userId: number, lossAmount: number, date?: string): Promise<void> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const query = `
      INSERT INTO daily_loss_tracking (user_id, date, loss_amount)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date)
      DO UPDATE SET
        loss_amount = daily_loss_tracking.loss_amount + EXCLUDED.loss_amount,
        updated_at = NOW()
    `;
    
    await this.pool.query(query, [userId, targetDate, lossAmount]);
  }

  async getDailyLoss(userId: number, date?: string): Promise<{ loss_amount: number; is_blocked: boolean } | null> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const query = 'SELECT loss_amount, is_blocked FROM daily_loss_tracking WHERE user_id = $1 AND date = $2';
    const result = await this.pool.query(query, [userId, targetDate]);
    return result.rows[0] || { loss_amount: 0, is_blocked: false };
  }

  async blockUserTrading(userId: number, date?: string): Promise<void> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const query = `
      INSERT INTO daily_loss_tracking (user_id, date, is_blocked)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (user_id, date)
      DO UPDATE SET
        is_blocked = TRUE,
        updated_at = NOW()
    `;
    
    await this.pool.query(query, [userId, targetDate]);
  }


  // ========== Conversation State Management ==========

  async setConversationState(
    userId: number, 
    state: { step: string; data?: any; type?: string; symbol?: string; marginType?: string }, 
    ttlMinutes = 5
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    
    const query = `
      INSERT INTO conversation_states (user_id, step, data, expires_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        step = EXCLUDED.step,
        data = EXCLUDED.data,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
    
    await this.pool.query(query, [
      userId,
      state.step,
      JSON.stringify(state.data || {}),
      expiresAt
    ]);
  }

  async getConversationState(userId: number): Promise<any> {
    const query = `
      SELECT step, data, expires_at
      FROM conversation_states 
      WHERE user_id = $1 AND expires_at > NOW()
    `;
    
    const result = await this.pool.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return undefined;
    }
    
    const row = result.rows[0];
    return {
      step: row.step,
      data: row.data || {},
      expiresAt: row.expires_at
    };
  }

  async deleteConversationState(userId: number): Promise<void> {
    const query = 'DELETE FROM conversation_states WHERE user_id = $1';
    await this.pool.query(query, [userId]);
  }

  async cleanupExpiredConversationStates(): Promise<number> {
    const query = 'DELETE FROM conversation_states WHERE expires_at < NOW()';
    const result = await this.pool.query(query);
    return result.rowCount || 0;
  }

  // ========== Health Checks ==========

  async healthCheck(): Promise<{ postgres: boolean }> {
    try {
      const pgResult = await this.pool.query('SELECT 1');
      
      return {
        postgres: pgResult.rows[0]['?column?'] === 1,
      };
    } catch (error) {
      console.error('[DB] Health check failed:', error);
      return {
        postgres: false,
      };
    }
  }

  // ========== Cleanup Operations ==========


  async cleanupOldOrders(daysOld = 30): Promise<number> {
    const query = 'DELETE FROM orders WHERE created_at < NOW() - INTERVAL \'$1 days\'';
    const result = await this.pool.query(query, [daysOld]);
    return result.rowCount || 0;
  }

  // ========== Referral System ==========

  async generateReferralCode(userId: number, username?: string): Promise<string> {
    // Generate SS_USERNAME_1234 format
    const cleanName = username?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'USER';
    const randomUID = Math.random().toString(36).substr(2, 4).toUpperCase();
    const referralCode = `SS_${cleanName}_${randomUID}`;

    const query = 'UPDATE users SET referral_code = $1 WHERE id = $2';
    await this.pool.query(query, [referralCode, userId]);
    
    return referralCode;
  }

  async createReferral(referrerCode: string, refereeId: number): Promise<void> {
    const query = `
      INSERT INTO referrals (referrer_id, referee_id, referral_code)
      SELECT u.id, $2, $1
      FROM users u 
      WHERE u.referral_code = $1
    `;
    await this.pool.query(query, [referrerCode, refereeId]);

    // Update referee with referrer info
    const updateQuery = `
      UPDATE users 
      SET invited_by = (SELECT id FROM users WHERE referral_code = $1)
      WHERE id = $2
    `;
    await this.pool.query(updateQuery, [referrerCode, refereeId]);
  }

  async getUserReferralStats(userId: number): Promise<{ code: string | null; referralCount: number; invitedBy: string | null }> {
    const query = `
      SELECT 
        u.referral_code,
        r.tg_id as invited_by_tg_id,
        (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id) as referral_count
      FROM users u
      LEFT JOIN users r ON u.invited_by = r.id
      WHERE u.id = $1
    `;
    const result = await this.pool.query(query, [userId]);
    const row = result.rows[0];

    return {
      code: row?.referral_code || null,
      referralCount: parseInt(row?.referral_count || '0'),
      invitedBy: row?.invited_by_tg_id || null
    };
  }

  async checkReferralCodeExists(code: string): Promise<boolean> {
    const query = 'SELECT 1 FROM users WHERE referral_code = $1';
    const result = await this.pool.query(query, [code]);
    return result.rows.length > 0;
  }

  async updateAdminStatus(userId: number, isAdmin: boolean): Promise<void> {
    const query = 'UPDATE users SET is_group_admin = $1 WHERE id = $2';
    await this.pool.query(query, [isAdmin, userId]);
  }

  async updateUserAdminStatus(telegramId: number, isAdmin: boolean): Promise<void> {
    const query = 'UPDATE users SET is_group_admin = $1 WHERE tg_id = $2';
    await this.pool.query(query, [isAdmin, telegramId]);
  }

  async getUserReferrals(userId: number): Promise<any[]> {
    const query = `
      SELECT 
        r.created_at,
        u.tg_id as referee_tg_id
      FROM referrals r
      JOIN users u ON r.referee_id = u.id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rows;
  }

  async getReferralCodeData(code: string): Promise<{ created_by: number } | null> {
    const query = 'SELECT id as created_by FROM users WHERE referral_code = $1';
    const result = await this.pool.query(query, [code]);
    return result.rows[0] || null;
  }

  async updateUserReferralCode(telegramId: number, referralCode: string): Promise<void> {
    const query = 'UPDATE users SET referral_code = $1 WHERE tg_id = $2';
    await this.pool.query(query, [referralCode, telegramId]);
  }

  async getTeamMembers(userId: number): Promise<any[]> {
    const query = `
      WITH RECURSIVE team_tree AS (
        -- Base case: direct referrals
        SELECT 
          u.id,
          u.tg_id,
          u.created_at as join_date,
          u.referral_code,
          u.is_group_admin,
          1 as level,
          ARRAY[u.id] as path
        FROM users u 
        WHERE u.invited_by = $1
        
        UNION ALL
        
        -- Recursive case: referrals of referrals
        SELECT 
          u.id,
          u.tg_id,
          u.created_at as join_date,
          u.referral_code,
          u.is_group_admin,
          tt.level + 1,
          tt.path || u.id
        FROM users u
        JOIN team_tree tt ON u.invited_by = tt.id
        WHERE tt.level < 3 -- Limit to 3 levels deep
        AND NOT u.id = ANY(tt.path) -- Prevent cycles
      )
      SELECT 
        id,
        tg_id,
        join_date,
        referral_code,
        is_group_admin,
        level,
        (SELECT COUNT(*) FROM users WHERE invited_by = team_tree.id) as direct_referrals
      FROM team_tree 
      ORDER BY level ASC, join_date DESC
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rows;
  }

  async getDetailedTeamStats(userId: number): Promise<{
    totalTeamSize: number;
    directReferrals: number;
    level2Referrals: number;
    level3Referrals: number;
    activeMembers: number;
    admins: number;
    recentJoins: number;
  }> {
    const query = `
      WITH RECURSIVE team_tree AS (
        -- Base case: direct referrals
        SELECT 
          u.id,
          u.tg_id,
          u.created_at,
          u.is_group_admin,
          1 as level
        FROM users u 
        WHERE u.invited_by = $1
        
        UNION ALL
        
        -- Recursive case: referrals of referrals
        SELECT 
          u.id,
          u.tg_id,
          u.created_at,
          u.is_group_admin,
          tt.level + 1
        FROM users u
        JOIN team_tree tt ON u.invited_by = tt.id
        WHERE tt.level < 3
      )
      SELECT 
        COUNT(*) as total_team_size,
        COUNT(*) FILTER (WHERE level = 1) as direct_referrals,
        COUNT(*) FILTER (WHERE level = 2) as level2_referrals,
        COUNT(*) FILTER (WHERE level = 3) as level3_referrals,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as recent_joins,
        COUNT(*) FILTER (WHERE is_group_admin = true) as admins,
        COUNT(*) as active_members
      FROM team_tree
    `;
    
    const result = await this.pool.query(query, [userId]);
    const row = result.rows[0];
    
    return {
      totalTeamSize: parseInt(row.total_team_size || '0'),
      directReferrals: parseInt(row.direct_referrals || '0'),
      level2Referrals: parseInt(row.level2_referrals || '0'), 
      level3Referrals: parseInt(row.level3_referrals || '0'),
      activeMembers: parseInt(row.active_members || '0'),
      admins: parseInt(row.admins || '0'),
      recentJoins: parseInt(row.recent_joins || '0')
    };
  }

  async getUserTeamRank(userId: number): Promise<{
    rank: number;
    totalUsers: number;
    teamSize: number;
  }> {
    const query = `
      WITH team_sizes AS (
        WITH RECURSIVE team_tree AS (
          SELECT 
            referrer.id as leader_id,
            member.id as member_id,
            1 as level
          FROM users referrer
          JOIN users member ON member.invited_by = referrer.id
          
          UNION ALL
          
          SELECT 
            tt.leader_id,
            member.id as member_id,
            tt.level + 1
          FROM team_tree tt
          JOIN users member ON member.invited_by = tt.member_id
          WHERE tt.level < 3
        )
        SELECT 
          leader_id,
          COUNT(DISTINCT member_id) as team_size
        FROM team_tree
        GROUP BY leader_id
      ),
      user_rank AS (
        SELECT 
          leader_id,
          team_size,
          RANK() OVER (ORDER BY team_size DESC) as rank
        FROM team_sizes
      )
      SELECT 
        COALESCE(ur.rank, 999999) as rank,
        (SELECT COUNT(DISTINCT leader_id) FROM team_sizes) as total_users,
        COALESCE(ur.team_size, 0) as team_size
      FROM user_rank ur
      WHERE ur.leader_id = $1
      
      UNION ALL
      
      SELECT 
        999999 as rank,
        (SELECT COUNT(DISTINCT leader_id) FROM team_sizes) as total_users,
        0 as team_size
      WHERE NOT EXISTS (SELECT 1 FROM user_rank WHERE leader_id = $1)
      
      LIMIT 1
    `;
    
    const result = await this.pool.query(query, [userId]);
    const row = result.rows[0];
    
    return {
      rank: parseInt(row.rank),
      totalUsers: parseInt(row.total_users || '0'),
      teamSize: parseInt(row.team_size || '0')
    };
  }
}