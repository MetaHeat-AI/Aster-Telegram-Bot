import dotenv from 'dotenv';
import { BotConfig, BotConfigSchema } from './types';
import { BotOrchestrator } from './core/BotOrchestrator';

// Load environment variables
dotenv.config();

/**
 * Load and validate configuration
 */
function loadConfig(): BotConfig {
  const config = {
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN!,
      adminIds: process.env.ADMIN_IDS?.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) || [],
    },
    aster: {
      baseUrl: process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com',
      defaultRecvWindow: parseInt(process.env.DEFAULT_RECV_WINDOW || '5000'),
      maxLeverage: parseInt(process.env.MAX_LEVERAGE || '20'),
    },
    database: {
      url: process.env.DATABASE_URL!,
    },
    redis: process.env.REDIS_URL ? {
      url: process.env.REDIS_URL,
    } : undefined,
    encryption: {
      key: process.env.ENCRYPTION_KEY!,
    },
    server: {
      port: parseInt(process.env.PORT || '3000'),
    },
    webhook: {
      url: process.env.WEBHOOK_URL!,
      secretToken: process.env.WEBHOOK_SECRET!,
      path: process.env.WEBHOOK_PATH || '/webhook',
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
    },
  };

  try {
    return BotConfigSchema.parse(config);
  } catch (error) {
    console.error('Configuration validation failed:', error);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    console.log('🤖 Starting Aster Trading Bot...');
    
    const config = loadConfig();
    const orchestrator = new BotOrchestrator(config);
    
    await orchestrator.start();
    
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('❌ Reason:', reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('📡 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📡 Received SIGINT, shutting down gracefully');
  process.exit(0);
});

// Start the application
if (require.main === module) {
  main();
}