import { Context } from 'telegraf';
import { BotEventEmitter, EventTypes } from '../events/EventEmitter';
import { UserState } from '../types';

export interface BotContext extends Context {
  userState?: UserState;
  correlationId?: string;
}

export abstract class BaseHandler {
  protected eventEmitter: BotEventEmitter;
  
  constructor(eventEmitter: BotEventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  protected async emitNavigation(
    ctx: BotContext, 
    from: string, 
    to: string, 
    context?: Record<string, any>
  ): Promise<void> {
    if (!ctx.userState) return;
    
    this.eventEmitter.emitEvent({
      type: EventTypes.NAVIGATION_CHANGED,
      timestamp: new Date(),
      userId: ctx.userState.userId,
      telegramId: ctx.userState.telegramId,
      correlationId: ctx.correlationId,
      from,
      to,
      context
    });
  }

  protected async emitError(
    ctx: BotContext, 
    error: Error, 
    context?: Record<string, any>
  ): Promise<void> {
    if (!ctx.userState) return;
    
    this.eventEmitter.emitEvent({
      type: EventTypes.ERROR_OCCURRED,
      timestamp: new Date(),
      userId: ctx.userState.userId,
      telegramId: ctx.userState.telegramId,
      correlationId: ctx.correlationId,
      error,
      context
    });
  }

  protected async emitApiCall(
    ctx: BotContext,
    endpoint: string,
    method: string,
    success: boolean,
    duration?: number
  ): Promise<void> {
    if (!ctx.userState) return;
    
    this.eventEmitter.emitEvent({
      type: success ? EventTypes.API_CALL_SUCCESS : EventTypes.API_CALL_FAILED,
      timestamp: new Date(),
      userId: ctx.userState.userId,
      telegramId: ctx.userState.telegramId,
      correlationId: ctx.correlationId,
      endpoint,
      method,
      success,
      duration
    });
  }

  protected getCorrelationId(ctx: BotContext): string {
    if (!ctx.correlationId) {
      ctx.correlationId = this.eventEmitter.createCorrelationId();
    }
    return ctx.correlationId;
  }

  // Template method pattern for consistent error handling
  protected async executeWithErrorHandling<T>(
    ctx: BotContext,
    operation: () => Promise<T>,
    errorMessage: string,
    context?: Record<string, any>
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      console.error(`[${this.constructor.name}] ${errorMessage}:`, error);
      await this.emitError(ctx, error as Error, { 
        operation: errorMessage,
        ...context 
      });
      await ctx.reply(`❌ ${errorMessage}. Please try again.`);
      return null;
    }
  }
}

// Interface for dependency injection
export interface HandlerDependencies {
  eventEmitter: BotEventEmitter;
  // Add other common dependencies here
}

// Factory pattern for handler creation
export abstract class HandlerFactory {
  static createHandler<T extends BaseHandler>(
    HandlerClass: new (eventEmitter: BotEventEmitter) => T,
    dependencies: HandlerDependencies
  ): T {
    return new HandlerClass(dependencies.eventEmitter);
  }
}