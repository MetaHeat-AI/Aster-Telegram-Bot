# Architecture Documentation

## Overview

The Aster Trading Bot is built using a **modern event-driven architecture** with clear separation of concerns, dependency injection, and comprehensive error handling. This design ensures scalability, maintainability, and ease of development.

## Architecture Principles

### 1. Event-Driven Design
- All interactions emit events through a centralized `BotEventEmitter`
- Loose coupling between components via events
- Comprehensive logging and monitoring through event streams
- Easy to add new features without modifying existing code

### 2. Separation of Concerns
- **Handlers**: UI logic and user interaction
- **Services**: Business logic and external API integration  
- **Middleware**: Cross-cutting concerns (auth, logging, rate limiting)
- **Events**: Communication between components

### 3. Dependency Injection
- Constructor injection for all dependencies
- Interface-based design for easy testing and mocking
- Centralized orchestrator manages all dependencies

### 4. Error Handling
- Consistent error handling patterns across all components
- Event-based error reporting and monitoring
- Graceful degradation and recovery

## Core Components

### 🧠 BotOrchestrator
**Location**: `src/core/BotOrchestrator.ts`

The main orchestrator that wires together all components. This is the **only class** that knows about the overall system architecture.

**Responsibilities**:
- Initialize all services and handlers
- Setup middleware pipeline
- Configure event listeners
- Manage bot lifecycle (start/stop)

```typescript
const orchestrator = new BotOrchestrator(config);
await orchestrator.start();
```

### 📡 Event System
**Location**: `src/events/`

Type-safe event system for decoupled communication.

**Key Features**:
- Strongly typed events with TypeScript
- Correlation IDs for request tracing
- Centralized event constants
- Built on Node.js EventEmitter

```typescript
// Emit a trading event
eventEmitter.emitEvent({
  type: EventTypes.TRADE_INITIATED,
  userId: 123,
  symbol: 'BTCUSDT',
  action: 'BUY'
});

// Listen for events
eventEmitter.onEvent(EventTypes.TRADE_EXECUTED, (event) => {
  console.log(`Trade executed: ${event.symbol}`);
});
```

### 🔐 Middleware
**Location**: `src/middleware/`

Cross-cutting concerns that run before handlers.

#### AuthMiddleware
- User authentication and session management
- API credential validation
- User state caching with TTL
- Admin-only command protection

```typescript
// Usage in orchestrator
this.bot.use(this.authMiddleware.middleware());
this.bot.use(this.authMiddleware.requireLinkedAccount());
```

### 🎯 Handlers
**Location**: `src/handlers/`

Handle user interactions and UI logic.

#### BaseHandler
Abstract base class providing:
- Event emission helpers
- Error handling templates
- Correlation ID management
- Consistent logging patterns

#### NavigationHandler
- Main menu and navigation logic
- Consistent keyboard layouts
- Navigation event tracking

#### TradingHandler
- Spot and perpetual futures trading interfaces
- Custom symbol handling
- Trade execution workflows

```typescript
// Adding a new handler
class MyHandler extends BaseHandler {
  async handleSomething(ctx: BotContext): Promise<void> {
    await this.executeWithErrorHandling(
      ctx,
      async () => {
        // Your logic here
        await this.emitNavigation(ctx, 'from', 'to');
      },
      'Operation failed'
    );
  }
}
```

### 🛠 Services
**Location**: `src/services/`

Business logic and external integrations.

#### ApiClientService
- API client lifecycle management
- Credential validation and caching
- Session cleanup and monitoring
- Rate limiting and error handling

#### PriceService
- Real-time price fetching
- Price caching with TTL
- Symbol validation
- Batch price operations

```typescript
// Using services
const client = await apiClientService.getOrCreateClient(userId);
const price = await priceService.getCurrentPrice('BTCUSDT');
```

## Data Flow

### 1. Request Flow
```
User Input → Middleware → Handler → Service → External API
     ↓           ↓          ↓         ↓           ↓
  Auth Check → Event → Business → Event → Response
```

### 2. Event Flow
```
User Action → Handler → Event → Listeners → Logging/Monitoring
```

### 3. Error Flow
```
Error → Handler → Error Event → Logger → User Notification
```

## Configuration

### Environment Variables
```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=32_character_key

# Optional
REDIS_URL=redis://localhost:6379
ASTER_BASE_URL=https://api.aster.exchange
PORT=3000
```

### Config Schema
Configuration is validated using Zod schemas:

```typescript
const config = BotConfigSchema.parse(envConfig);
```

## Testing Strategy

### Unit Tests
- Test handlers with mocked dependencies
- Test services with mocked external APIs
- Test middleware with mocked contexts

### Integration Tests
- Test complete workflows end-to-end
- Test error scenarios and recovery
- Test rate limiting and caching

### Example Test
```typescript
describe('TradingHandler', () => {
  let handler: TradingHandler;
  let mockApiService: jest.Mocked<ApiClientService>;
  
  beforeEach(() => {
    mockApiService = createMockApiService();
    handler = new TradingHandler({
      eventEmitter: new BotEventEmitter(),
      apiClientService: mockApiService,
      priceService: mockPriceService
    });
  });
  
  it('should handle spot trading', async () => {
    await handler.handleSpotTrading(mockCtx);
    expect(mockApiService.getOrCreateClient).toHaveBeenCalled();
  });
});
```

## Monitoring & Observability

### Event-Based Logging
All operations emit events that can be:
- Logged to console/files
- Sent to monitoring systems
- Used for metrics and alerting

### Health Checks
```bash
GET /health
{
  "status": "healthy",
  "uptime": 3600,
  "clients": 42,
  "auth_cache": { "size": 150 }
}
```

### Metrics
```bash
GET /metrics
{
  "api_clients": 42,
  "auth_cache": { "size": 150, "hitRate": 0.95 }
}
```

## Error Handling

### Levels of Error Handling

1. **Component Level**: Each handler/service catches its own errors
2. **Event Level**: Errors emit events for monitoring
3. **Bot Level**: Global error handler for uncaught exceptions
4. **Process Level**: Graceful shutdown on critical errors

### Error Types
```typescript
interface ErrorEvent extends UserEvent {
  error: Error;
  context?: Record<string, any>;
}
```

## Adding New Features

### 1. Create Handler
```typescript
export class NewFeatureHandler extends BaseHandler {
  async handleNewFeature(ctx: BotContext): Promise<void> {
    // Implementation
  }
}
```

### 2. Register in Orchestrator
```typescript
// In BotOrchestrator.setupActions()
this.bot.action('new_feature', (ctx) => 
  this.newFeatureHandler.handleNewFeature(ctx)
);
```

### 3. Add Events (if needed)
```typescript
// In EventEmitter.ts
export const EventTypes = {
  NEW_FEATURE_STARTED: 'new_feature.started',
  // ...
} as const;
```

### 4. Add Tests
```typescript
describe('NewFeatureHandler', () => {
  // Tests
});
```

## Best Practices

### 1. Always Use Events
- Emit events for all significant operations
- Include correlation IDs for tracing
- Use typed events for better IDE support

### 2. Error Handling
- Use `executeWithErrorHandling` template method
- Emit error events for monitoring
- Provide user-friendly error messages

### 3. Dependency Injection
- Accept dependencies in constructor
- Use interfaces for easy mocking
- Keep dependencies minimal and focused

### 4. Testing
- Mock all external dependencies
- Test error scenarios
- Use correlation IDs in tests

### 5. Performance
- Cache frequently accessed data
- Use connection pooling for databases
- Clean up resources periodically

## Production Considerations

### Scaling
- Each service is stateless (except for caches)
- Can run multiple instances behind load balancer
- Database connection pooling handles concurrent requests

### Monitoring
- All events are logged with correlation IDs
- Health check endpoint for load balancer
- Metrics endpoint for monitoring systems

### Security
- API credentials encrypted in database
- Rate limiting on all endpoints
- Admin commands require explicit authorization

### Reliability
- Graceful shutdown handling
- Database connection retry logic
- API client recreation on failures