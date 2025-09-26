# Developer Onboarding Guide

## Quick Start

### Prerequisites
- Node.js 18+ 
- PostgreSQL database
- Redis (optional, for caching)
- Telegram Bot Token

### 1. Clone and Setup
```bash
git clone <repository>
cd aster-bot
npm install
```

### 2. Environment Configuration
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Database Setup
```bash
# Create database
createdb aster_bot

# Set DATABASE_URL in .env
DATABASE_URL=postgresql://user:pass@localhost/aster_bot
```

### 4. Run Development
```bash
npm run dev
```

## Project Structure

```
src/
├── core/                 # Main orchestrator
│   └── BotOrchestrator.ts
├── events/               # Event system
│   └── EventEmitter.ts
├── handlers/             # UI and interaction logic
│   ├── BaseHandler.ts
│   ├── NavigationHandler.ts
│   └── TradingHandler.ts
├── middleware/           # Cross-cutting concerns
│   └── AuthMiddleware.ts
├── services/             # Business logic
│   ├── ApiClientService.ts
│   └── PriceService.ts
├── types.ts             # TypeScript definitions
├── db.ts                # Database layer
├── main.ts              # Entry point
└── bot.ts               # Legacy (being refactored)
```

## Development Workflow

### Adding a New Feature

#### 1. Plan the Feature
- What user interaction does it handle?
- What business logic is needed?
- What external APIs are involved?
- What events should be emitted?

#### 2. Create Handler (if needed)
```typescript
// src/handlers/NewFeatureHandler.ts
import { BaseHandler, BotContext } from './BaseHandler';

export class NewFeatureHandler extends BaseHandler {
  async handleNewFeature(ctx: BotContext): Promise<void> {
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        // Your implementation
        await this.emitNavigation(ctx, 'from', 'to');
      },
      'Failed to handle new feature'
    );
  }
}
```

#### 3. Create Service (if needed)
```typescript
// src/services/NewService.ts
export class NewService {
  constructor(
    private eventEmitter: BotEventEmitter,
    private db: DatabaseManager
  ) {}

  async doSomething(): Promise<void> {
    // Business logic
  }
}
```

#### 4. Wire in Orchestrator
```typescript
// In BotOrchestrator.ts

// Initialize in constructor
this.newFeatureHandler = new NewFeatureHandler(this.eventEmitter);

// Register actions
this.bot.action('new_feature', (ctx) => 
  this.newFeatureHandler.handleNewFeature(ctx)
);
```

#### 5. Add Tests
```typescript
// tests/handlers/NewFeatureHandler.test.ts
describe('NewFeatureHandler', () => {
  let handler: NewFeatureHandler;
  let mockEventEmitter: jest.Mocked<BotEventEmitter>;

  beforeEach(() => {
    mockEventEmitter = createMockEventEmitter();
    handler = new NewFeatureHandler(mockEventEmitter);
  });

  it('should handle new feature', async () => {
    const mockCtx = createMockContext();
    await handler.handleNewFeature(mockCtx);
    // Assertions
  });
});
```

### Testing

#### Run Tests
```bash
npm test
npm run test:watch
npm run test:coverage
```

#### Test Structure
```
tests/
├── handlers/
├── services/
├── middleware/
└── utils/
```

#### Test Utilities
```typescript
// tests/utils/mocks.ts
export function createMockContext(): BotContext {
  return {
    userState: {
      userId: 123,
      telegramId: 456,
      isLinked: true,
      // ...
    },
    reply: jest.fn(),
    editMessageText: jest.fn(),
    // ...
  };
}
```

### Code Style

#### TypeScript Conventions
- Use strict mode
- Prefer interfaces over types
- Use explicit return types for public methods
- Document public APIs with JSDoc

#### Naming Conventions
- **Files**: PascalCase for classes, camelCase for utilities
- **Classes**: PascalCase (e.g., `TradingHandler`)
- **Methods**: camelCase (e.g., `handleSpotTrading`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `EVENT_TYPES`)
- **Interfaces**: PascalCase with descriptive names

#### Error Handling
```typescript
// ✅ Good
await this.executeWithErrorHandling(
  ctx,
  async () => {
    // Business logic
  },
  'User-friendly error message'
);

// ❌ Avoid
try {
  // Business logic
} catch (error) {
  console.error(error);
  await ctx.reply('Error occurred');
}
```

#### Event Emission
```typescript
// ✅ Good
this.eventEmitter.emitEvent({
  type: EventTypes.TRADE_INITIATED,
  timestamp: new Date(),
  userId: ctx.userState.userId,
  correlationId: ctx.correlationId,
  symbol: 'BTCUSDT'
});

// ❌ Avoid
console.log('Trade started');
```

## Debugging

### Logging
```typescript
// Event-based logging
this.eventEmitter.emitEvent({
  type: 'DEBUG',
  message: 'Debug info',
  context: { data }
});

// Console logging (development only)
console.log(`[${this.constructor.name}] Debug info:`, data);
```

### Correlation IDs
Every request gets a correlation ID for tracing:
```typescript
console.log(`[${ctx.correlationId}] Processing request`);
```

### Common Issues

#### "API session not found"
- Check if user has linked credentials
- Verify database connection
- Check ApiClientService logs

#### "Failed to load interface" 
- Check middleware execution order
- Verify user authentication
- Check handler error logs

#### Event not firing
- Verify event type spelling
- Check if listener is registered
- Ensure eventEmitter is passed correctly

## Database Schema

### Tables
```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API Credentials (encrypted)
CREATE TABLE api_credentials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  aster_key_enc TEXT NOT NULL,
  aster_secret_enc TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_ok_at TIMESTAMP WITH TIME ZONE
);

-- User Settings
CREATE TABLE settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  leverage_cap INTEGER DEFAULT 20,
  default_leverage INTEGER DEFAULT 3,
  size_presets JSONB DEFAULT '[50, 100, 250]',
  -- ... other settings
);
```

### Migrations
Add new migrations in `src/migrations/`:
```typescript
// src/migrations/001_add_new_table.ts
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE new_table (
      id SERIAL PRIMARY KEY,
      data JSONB
    );
  `);
}
```

## Environment Variables

### Required
```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
DATABASE_URL=postgresql://user:pass@localhost/dbname
ENCRYPTION_KEY=your_32_character_encryption_key_here
```

### Optional
```bash
# Redis for caching
REDIS_URL=redis://localhost:6379

# API Configuration
ASTER_BASE_URL=https://api.aster.exchange
ASTER_RECV_WINDOW=5000
MAX_LEVERAGE=20

# Server
PORT=3000

# Rate Limiting
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100

# Admin Users (comma-separated Telegram IDs)
ADMIN_IDS=123456789,987654321
```

## Production Deployment

### Build and Run
```bash
npm run build
npm start
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["npm", "start"]
```

### Health Checks
The bot exposes health check endpoints:
```bash
# Health status
curl http://localhost:3000/health

# Metrics
curl http://localhost:3000/metrics
```

### Monitoring
Monitor these events for production health:
- `bot.started` / `bot.stopped`
- `api.call.failed` (API failures)
- `error.occurred` (Application errors)
- `trade.executed` (Successful trades)

## API Integration

### Adding New Exchange APIs

#### 1. Create API Client
```typescript
// src/api/NewExchangeClient.ts
export class NewExchangeClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private apiSecret: string
  ) {}

  async getBalance(): Promise<BalanceInfo> {
    // Implementation
  }
}
```

#### 2. Update ApiClientService
```typescript
// Support multiple exchanges
async getOrCreateClient(userId: number, exchange: string): Promise<ApiClient> {
  switch (exchange) {
    case 'aster':
      return this.createAsterClient(userId);
    case 'new_exchange':
      return this.createNewExchangeClient(userId);
    default:
      throw new Error(`Unsupported exchange: ${exchange}`);
  }
}
```

### Rate Limiting
Built-in rate limiting per user:
```typescript
// Check rate limit before API calls
const remaining = await this.checkRateLimit(userId);
if (remaining <= 0) {
  throw new RateLimitError('Rate limit exceeded');
}
```

## Security Considerations

### API Credentials
- Always encrypt credentials in database
- Use environment variables for encryption keys
- Rotate encryption keys periodically
- Never log API credentials

### User Input Validation
```typescript
// Validate all user input
const symbol = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
  throw new ValidationError('Invalid symbol format');
}
```

### Admin Commands
```typescript
// Protect admin commands
this.bot.command('admin', 
  this.authMiddleware.requireAdmin(this.config.telegram.adminIds),
  (ctx) => this.handleAdminCommand(ctx)
);
```

## Troubleshooting

### Common Development Issues

#### TypeScript Errors
```bash
npm run type-check
```

#### Database Connection Issues
```bash
# Test database connection
npm run db:test
```

#### Bot Not Responding
1. Check bot token is valid
2. Verify webhook/polling setup
3. Check network connectivity
4. Review error logs

#### Tests Failing
1. Clear test database: `npm run test:db:reset`
2. Update snapshots: `npm test -- -u`
3. Check mock implementations

### Performance Issues

#### High Memory Usage
- Check for memory leaks in event listeners
- Monitor cache sizes
- Review database connection pooling

#### Slow API Responses
- Check API client connection pooling
- Monitor external API response times
- Review caching strategies

### Getting Help

#### Internal Resources
- Check `ARCHITECTURE.md` for system design
- Review existing handler implementations
- Check test files for usage examples

#### External Resources
- [Telegraf Documentation](https://telegraf.js.org/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

#### Code Review Checklist
- [ ] Proper error handling with events
- [ ] Type safety with interfaces
- [ ] Tests cover main scenarios
- [ ] Documentation updated
- [ ] No hardcoded secrets
- [ ] Correlation IDs used for tracing
- [ ] Events emitted for monitoring
- [ ] User input validated
- [ ] Rate limiting considered