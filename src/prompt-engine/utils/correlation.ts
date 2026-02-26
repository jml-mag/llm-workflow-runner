// amplify/functions/workflow-runner/src/prompt-engine/utils/correlation.ts
import { randomUUID } from "crypto";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "PromptEngine.Correlation" });

/**
 * Correlation context for tracking requests across the entire prompt engine
 * Uses AsyncLocalStorage pattern for Node.js Lambda environments
 */
class CorrelationContext {
  private static instance: CorrelationContext;
  private correlationId: string | null = null;
  private requestMetadata: RequestMetadata = {};

  static getInstance(): CorrelationContext {
    if (!CorrelationContext.instance) {
      CorrelationContext.instance = new CorrelationContext();
    }
    return CorrelationContext.instance;
  }

  /**
   * Set correlation ID for current execution context
   */
  setCorrelationId(id: string, metadata: Partial<RequestMetadata> = {}): void {
    this.correlationId = id;
    this.requestMetadata = {
      startTime: Date.now(),
      lambdaRequestId: process.env.AWS_REQUEST_ID,
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      ...metadata
    };

    logger.debug("Correlation ID set", {
      correlationId: id,
      metadata: this.requestMetadata
    });
  }

  /**
   * Get current correlation ID, generating one if none exists
   */
  getCorrelationId(): string {
    if (!this.correlationId) {
      this.correlationId = randomUUID();
      this.setCorrelationId(this.correlationId);
      
      logger.debug("Generated new correlation ID", {
        correlationId: this.correlationId
      });
    }
    return this.correlationId;
  }

  /**
   * Get current request metadata
   */
  getRequestMetadata(): RequestMetadata {
    return { ...this.requestMetadata };
  }

  /**
   * Execute function with specific correlation ID context
   */
  withCorrelationId<T>(id: string, metadata: Partial<RequestMetadata>, fn: () => T): T {
    const previousId = this.correlationId;
    const previousMetadata = { ...this.requestMetadata };
    
    this.setCorrelationId(id, metadata);
    
    try {
      return fn();
    } finally {
      this.correlationId = previousId;
      this.requestMetadata = previousMetadata;
    }
  }

  /**
   * Execute async function with specific correlation ID context
   */
  async withCorrelationIdAsync<T>(
    id: string, 
    metadata: Partial<RequestMetadata>, 
    fn: () => Promise<T>
  ): Promise<T> {
    const previousId = this.correlationId;
    const previousMetadata = { ...this.requestMetadata };
    
    this.setCorrelationId(id, metadata);
    
    try {
      return await fn();
    } finally {
      this.correlationId = previousId;
      this.requestMetadata = previousMetadata;
    }
  }

  /**
   * Clear correlation context (useful for testing)
   */
  clear(): void {
    this.correlationId = null;
    this.requestMetadata = {};
  }

  /**
   * Get processing statistics for current request
   */
  getProcessingStats(): ProcessingStats | null {
    if (!this.requestMetadata.startTime) {
      return null;
    }

    const now = Date.now();
    return {
      correlationId: this.correlationId || 'unknown',
      startTime: this.requestMetadata.startTime,
      currentTime: now,
      elapsedMs: now - this.requestMetadata.startTime,
      lambdaRequestId: this.requestMetadata.lambdaRequestId,
      functionName: this.requestMetadata.functionName,
      functionVersion: this.requestMetadata.functionVersion
    };
  }
}

// Singleton instance
export const correlationContext = CorrelationContext.getInstance();

/**
 * Request metadata interface
 */
interface RequestMetadata {
  startTime?: number;
  lambdaRequestId?: string;
  functionName?: string;
  functionVersion?: string;
  userId?: string;
  workflowId?: string;
  conversationId?: string;
  modelId?: string;
  operation?: string;
}

/**
 * Processing statistics interface
 */
interface ProcessingStats {
  correlationId: string;
  startTime: number;
  currentTime: number;
  elapsedMs: number;
  lambdaRequestId?: string;
  functionName?: string;
  functionVersion?: string;
}

/**
 * Lambda event interface for proper typing
 */
interface LambdaEvent {
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  operation?: string;
  httpMethod?: string;
  userId?: string;
  workflowId?: string;
  conversationId?: string;
  modelId?: string;
  correlationId?: string;
  requestId?: string;
  requestContext?: {
    authorizer?: {
      claims?: {
        sub?: string;
      };
    };
  };
}

/**
 * Decorator for automatically adding correlation ID to function execution
 */
export function withCorrelation(metadata: Partial<RequestMetadata> = {}) {
  return function <T extends (...args: unknown[]) => unknown>(
    target: unknown,
    propertyName: string,
    descriptor: TypedPropertyDescriptor<T>
  ) {
    const method = descriptor.value!;

    descriptor.value = function (this: unknown, ...args: Parameters<T>) {
      const correlationId = correlationContext.getCorrelationId();
      
      return correlationContext.withCorrelationId(correlationId, metadata, () => {
        return method.apply(this, args);
      });
    } as T;

    return descriptor;
  };
}

/**
 * Async decorator for automatically adding correlation ID to async function execution
 */
export function withCorrelationAsync(metadata: Partial<RequestMetadata> = {}) {
  return function <T extends (...args: unknown[]) => Promise<unknown>>(
    target: unknown,
    propertyName: string,
    descriptor: TypedPropertyDescriptor<T>
  ) {
    const method = descriptor.value!;

    descriptor.value = function (this: unknown, ...args: Parameters<T>) {
      const correlationId = correlationContext.getCorrelationId();
      
      return correlationContext.withCorrelationIdAsync(correlationId, metadata, () => {
        return method.apply(this, args);
      });
    } as T;

    return descriptor;
  };
}

/**
 * Utility functions for correlation ID management
 */
export class CorrelationUtils {
  /**
   * Generate a new correlation ID with optional prefix
   */
  static generateId(prefix?: string): string {
    const id = randomUUID();
    return prefix ? `${prefix}-${id}` : id;
  }

  /**
   * Validate correlation ID format
   */
  static isValidCorrelationId(id: string): boolean {
    if (!id || typeof id !== 'string') {
      return false;
    }

    // Check for UUID format (with optional prefix)
    const uuidPattern = /^([a-zA-Z0-9-_]+-)?\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b$/;
    return uuidPattern.test(id);
  }

  /**
   * Extract correlation ID from various sources
   */
  static extractCorrelationId(sources: {
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
    event?: LambdaEvent;
  }): string | null {
    const { headers = {}, metadata = {}, event } = sources;

    // Try various common header names
    const headerNames = [
      'x-correlation-id',
      'x-request-id', 
      'correlation-id',
      'request-id',
      'trace-id'
    ];

    for (const headerName of headerNames) {
      const headerValue = headers[headerName] || headers[headerName.toLowerCase()];
      if (headerValue && this.isValidCorrelationId(headerValue)) {
        return headerValue;
      }
    }

    // Try metadata fields
    const metadataValue = metadata.correlationId || metadata.requestId;
    if (metadataValue && typeof metadataValue === 'string' && this.isValidCorrelationId(metadataValue)) {
      return metadataValue;
    }

    // Try event fields for Lambda - Fixed: properly handle event type
    if (event) {
      const eventCorrelationId = event.correlationId || event.requestId;
      if (eventCorrelationId && typeof eventCorrelationId === 'string' && this.isValidCorrelationId(eventCorrelationId)) {
        return eventCorrelationId;
      }
    }

    return null;
  }

  /**
   * Create correlation headers for HTTP requests
   */
  static createCorrelationHeaders(correlationId?: string): Record<string, string> {
    const id = correlationId || correlationContext.getCorrelationId();
    
    return {
      'X-Correlation-ID': id,
      'X-Request-ID': id,
    };
  }

  /**
   * Log with correlation context
   */
  static logWithCorrelation(level: 'debug' | 'info' | 'warn' | 'error', message: string, data: Record<string, unknown> = {}) {
    const correlationId = correlationContext.getCorrelationId();
    const stats = correlationContext.getProcessingStats();
    
    const logData = {
      ...data,
      correlationId,
      processingTimeMs: stats?.elapsedMs,
      lambdaRequestId: stats?.lambdaRequestId
    };

    switch (level) {
      case 'debug':
        logger.debug(message, logData);
        break;
      case 'info':
        logger.info(message, logData);
        break;
      case 'warn':
        logger.warn(message, logData);
        break;
      case 'error':
        logger.error(message, logData);
        break;
    }
  }
}

/**
 * Lambda event handler wrapper that automatically sets correlation ID
 */
export function withCorrelationHandler<T extends unknown[], R>(
  handler: (...args: T) => Promise<R>,
  options: {
    generateIfMissing?: boolean;
    metadataExtractor?: (event: LambdaEvent) => Partial<RequestMetadata>;
  } = {}
) {
  return async (...args: T): Promise<R> => {
    const [event] = args;
    const { generateIfMissing = true, metadataExtractor } = options;
    
    // Extract correlation ID from event - Fixed: properly type the event
    const lambdaEvent = event as unknown as LambdaEvent;
    let correlationId = CorrelationUtils.extractCorrelationId({
      event: lambdaEvent,
      headers: lambdaEvent?.headers || {},
      metadata: lambdaEvent?.metadata || {}
    });

    // Generate if missing and configured to do so
    if (!correlationId && generateIfMissing) {
      correlationId = CorrelationUtils.generateId('prompt-engine');
    }

    if (!correlationId) {
      // No correlation ID available, execute without context
      return handler(...args);
    }

    // Extract additional metadata
    const metadata: Partial<RequestMetadata> = {
      operation: lambdaEvent?.operation || lambdaEvent?.httpMethod || 'unknown',
      userId: lambdaEvent?.userId || lambdaEvent?.requestContext?.authorizer?.claims?.sub,
      workflowId: lambdaEvent?.workflowId,
      conversationId: lambdaEvent?.conversationId,
      modelId: lambdaEvent?.modelId,
      ...metadataExtractor?.(lambdaEvent)
    };

    // Execute with correlation context
    return correlationContext.withCorrelationIdAsync(correlationId, metadata, () => {
      return handler(...args);
    });
  };
}

/**
 * Export commonly used functions
 */
export {
  CorrelationContext,
  type RequestMetadata,
  type ProcessingStats,
  type LambdaEvent
};