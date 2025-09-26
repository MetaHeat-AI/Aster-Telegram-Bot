import { EventEmitter as NodeEventEmitter } from 'events';

export interface BaseEvent {
  type: string;
  timestamp: Date;
  userId: number;
  correlationId?: string;
}

export interface UserEvent extends BaseEvent {
  telegramId: number;
}

export interface TradingEvent extends UserEvent {
  symbol: string;
  action: 'BUY' | 'SELL';
  amount?: string;
  leverage?: number;
}

export interface NavigationEvent extends UserEvent {
  from: string;
  to: string;
  context?: Record<string, any>;
}

export interface ErrorEvent extends UserEvent {
  error: Error;
  context?: Record<string, any>;
}

export interface ApiEvent extends UserEvent {
  endpoint: string;
  method: string;
  success: boolean;
  duration?: number;
}

export type BotEvent = 
  | TradingEvent 
  | NavigationEvent 
  | ErrorEvent 
  | ApiEvent
  | UserEvent;

export class BotEventEmitter extends NodeEventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Increase for production
  }

  // Type-safe event emission
  emitEvent<T extends BotEvent>(event: T): boolean {
    return this.emit(event.type, event);
  }

  // Type-safe event listening
  onEvent<T extends BotEvent>(
    eventType: string, 
    listener: (event: T) => void | Promise<void>
  ): this {
    return this.on(eventType, listener);
  }

  // Utility method to create correlation IDs
  createCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Event type constants
export const EventTypes = {
  // User Events
  USER_LINKED: 'user.linked',
  USER_UNLINKED: 'user.unlinked',
  USER_AUTHENTICATED: 'user.authenticated',
  
  // Trading Events
  TRADE_INITIATED: 'trading.initiated',
  TRADE_PREVIEW_GENERATED: 'trading.preview.generated',
  TRADE_EXECUTED: 'trading.executed',
  TRADE_FAILED: 'trading.failed',
  
  // Navigation Events
  NAVIGATION_CHANGED: 'navigation.changed',
  INTERFACE_LOADED: 'interface.loaded',
  INTERFACE_FAILED: 'interface.failed',
  
  // API Events
  API_CALL_SUCCESS: 'api.call.success',
  API_CALL_FAILED: 'api.call.failed',
  API_CLIENT_CREATED: 'api.client.created',
  
  // Error Events
  ERROR_OCCURRED: 'error.occurred',
  ERROR_RECOVERED: 'error.recovered',
  
  // System Events
  BOT_STARTED: 'system.bot.started',
  BOT_STOPPED: 'system.bot.stopped',
  HEALTH_CHECK: 'system.health.check'
} as const;