// amplify/functions/workflow-runner/src/prompt-engine/circuit-breaker/CircuitBreaker.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { randomUUID } from "crypto";
import type { Schema } from "../../../../../data/resource";

const logger = new Logger({ serviceName: "PromptEngine.CircuitBreaker" });
const metrics = new Metrics({ serviceName: "PromptEngine.CircuitBreaker" });

export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

export interface CircuitBreakerState {
  modelId: string;
  disabled: boolean;
  reason?: string;
  errorThreshold: number;
  timeWindow: number; // seconds
  minRequests: number;
  lastTripped?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  reason?: string;
  errorRate?: number;
  requestCount?: number;
}

interface ErrorRateStats {
  requestCount: number;
  errorCount: number;
  errorRate: number;
}

/**
 * Model-level circuit breaker for reliability protection
 * Automatically opens circuits on high error rates and manual override capability
 */
export class CircuitBreaker {
  private readonly DEFAULT_CONFIG = {
    errorThreshold: 0.05, // 5% error rate
    timeWindow: 300, // 5 minutes
    minRequests: 10, // Minimum requests before circuit can trip
  };

  constructor(private readonly dataClient: DataClient) {}

  /**
   * Check if model is healthy and available for use
   */
  async checkModelHealth(modelId: string): Promise<HealthCheckResult> {
    const startTime = Date.now();

    logger.debug("Checking model health", { modelId });

    try {
      // Get or create circuit breaker state
      const circuitState = await this.getOrCreateCircuitState(modelId);

      // Check manual override first
      if (circuitState.disabled) {
        const result = {
          healthy: false,
          reason: circuitState.reason || 'Circuit breaker manually opened'
        };

        logger.warn("Circuit breaker manually disabled", {
          modelId,
          reason: circuitState.reason,
          lastTripped: circuitState.lastTripped
        });

        metrics.addMetric('CircuitBreakerManuallyOpen', MetricUnit.Count, 1);
        return result;
      }

      // Check automatic circuit conditions
      const errorStats = await this.getRecentErrorRate(modelId, circuitState.timeWindow);

      const shouldTrip = errorStats.requestCount >= circuitState.minRequests && 
                        errorStats.errorRate > circuitState.errorThreshold;

      if (shouldTrip) {
        const reason = `Automatic trip: error rate ${(errorStats.errorRate * 100).toFixed(1)}% exceeds threshold ${(circuitState.errorThreshold * 100).toFixed(1)}%`;
        
        await this.tripCircuitBreaker(modelId, reason);

        const result = {
          healthy: false,
          reason,
          errorRate: errorStats.errorRate,
          requestCount: errorStats.requestCount
        };

        logger.error("Circuit breaker automatically tripped", {
          modelId,
          errorRate: errorStats.errorRate,
          errorCount: errorStats.errorCount,
          requestCount: errorStats.requestCount,
          threshold: circuitState.errorThreshold,
          reason
        });

        metrics.addMetric('CircuitBreakerAutoTripped', MetricUnit.Count, 1);
        metrics.addMetric('ErrorRateAtTrip', MetricUnit.Percent, errorStats.errorRate * 100);

        return result;
      }

      // Circuit is healthy
      const checkTime = Date.now() - startTime;
      
      logger.debug("Model health check passed", {
        modelId,
        errorRate: errorStats.errorRate,
        requestCount: errorStats.requestCount,
        checkTime
      });

      metrics.addMetric('CircuitBreakerHealthy', MetricUnit.Count, 1);
      metrics.addMetric('HealthCheckLatency', MetricUnit.Milliseconds, checkTime);

      return {
        healthy: true,
        errorRate: errorStats.errorRate,
        requestCount: errorStats.requestCount
      };

    } catch (error) {
      const checkTime = Date.now() - startTime;
      
      logger.error("Circuit breaker health check failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        modelId,
        checkTime
      });

      metrics.addMetric('CircuitBreakerHealthCheckFailure', MetricUnit.Count, 1);

      // Fail open - allow requests if we can't determine health
      return {
        healthy: true,
        reason: 'Health check failed - failing open'
      };
    }
  }

  /**
   * Manually trip circuit breaker
   */
  async manuallyTripCircuitBreaker(
    modelId: string, 
    reason: string, 
    operator: string
  ): Promise<void> {
    logger.info("Manually tripping circuit breaker", {
      modelId,
      reason,
      operator
    });

    await this.updateCircuitState(modelId, {
      disabled: true,
      reason,
      updatedBy: operator,
      updatedAt: new Date().toISOString(),
      lastTripped: new Date().toISOString()
    });

    // Create audit log
    await this.createAuditLog({
      operation: 'CIRCUIT_OPEN',
      modelId,
      operator,
      reason,
      timestamp: new Date().toISOString()
    });

    metrics.addMetric('CircuitBreakerManuallyTripped', MetricUnit.Count, 1);
  }

  /**
   * Reset/close circuit breaker
   */
  async resetCircuitBreaker(
    modelId: string,
    operator: string,
    reason: string = 'Manual reset'
  ): Promise<void> {
    logger.info("Resetting circuit breaker", {
      modelId,
      operator,
      reason
    });

    await this.updateCircuitState(modelId, {
      disabled: false,
      reason: undefined,
      updatedBy: operator,
      updatedAt: new Date().toISOString()
    });

    // Create audit log
    await this.createAuditLog({
      operation: 'CIRCUIT_CLOSE',
      modelId,
      operator,
      reason,
      timestamp: new Date().toISOString()
    });

    metrics.addMetric('CircuitBreakerReset', MetricUnit.Count, 1);
  }

  /**
   * Get or create circuit breaker state for model
   */
  private async getOrCreateCircuitState(modelId: string): Promise<CircuitBreakerState> {
    try {
      const result = await this.dataClient.models.ModelCircuitBreaker.get({
        id: modelId  // Fixed: use id instead of modelId
      });

      if (result.data) {
        return {
          modelId: result.data.modelId,
          disabled: result.data.disabled ?? false,
          reason: result.data.reason || undefined,
          errorThreshold: result.data.errorThreshold ?? this.DEFAULT_CONFIG.errorThreshold,
          timeWindow: result.data.timeWindow ?? this.DEFAULT_CONFIG.timeWindow,
          minRequests: result.data.minRequests ?? this.DEFAULT_CONFIG.minRequests,
          lastTripped: result.data.lastTripped || undefined,
          updatedAt: result.data.updatedAt,
          updatedBy: result.data.updatedBy
        };
      }

      // Create default state
      const defaultState = {
        modelId,
        disabled: false,
        errorThreshold: this.DEFAULT_CONFIG.errorThreshold,
        timeWindow: this.DEFAULT_CONFIG.timeWindow,
        minRequests: this.DEFAULT_CONFIG.minRequests,
        updatedAt: new Date().toISOString(),
        updatedBy: 'SYSTEM'
      };

      await this.dataClient.models.ModelCircuitBreaker.create({
        id: modelId,  // Fixed: added id field
        ...defaultState
      });

      logger.info("Created default circuit breaker state", {
        modelId,
        config: defaultState
      });

      return defaultState;

    } catch (error) {
      logger.warn("Failed to get/create circuit state, using defaults", {
        error: error instanceof Error ? error.message : "Unknown error",
        modelId
      });

      // Return default configuration if database operations fail
      return {
        modelId,
        disabled: false,
        errorThreshold: this.DEFAULT_CONFIG.errorThreshold,
        timeWindow: this.DEFAULT_CONFIG.timeWindow,
        minRequests: this.DEFAULT_CONFIG.minRequests,
        updatedAt: new Date().toISOString(),
        updatedBy: 'SYSTEM'
      };
    }
  }

  /**
   * Get recent error rate statistics from audit logs
   */
  private async getRecentErrorRate(modelId: string, timeWindowSeconds: number): Promise<ErrorRateStats> {
    const cutoffTime = new Date(Date.now() - (timeWindowSeconds * 1000)).toISOString();

    try {
      // Query audit logs for recent operations - Fixed: use list instead of listByModel
      const auditResult = await this.dataClient.models.AuditLog.list({
        filter: {
          modelId: { eq: modelId },
          timestamp: { gt: cutoffTime }
        }
      });

      if (!auditResult.data) {
        return { requestCount: 0, errorCount: 0, errorRate: 0 };
      }

      // Count total requests and errors
      let requestCount = 0;
      let errorCount = 0;

      auditResult.data.forEach(entry => {
        // Count all prompt operations as requests - handle nullable operation
        if (entry.operation && ['CREATE', 'DEPLOY', 'ROLLBACK', 'UPDATE'].includes(entry.operation)) {
          requestCount++;
        }
        
        // Count circuit breaker openings and failed operations as errors
        if (entry.operation === 'CIRCUIT_OPEN' || (entry.reason && entry.reason.toLowerCase().includes('error'))) {
          errorCount++;
        }
      });

      const errorRate = requestCount > 0 ? errorCount / requestCount : 0;

      logger.debug("Error rate calculation", {
        modelId,
        timeWindowSeconds,
        requestCount,
        errorCount,
        errorRate,
        cutoffTime
      });

      return { requestCount, errorCount, errorRate };

    } catch (error) {
      logger.warn("Failed to calculate error rate, assuming healthy", {
        error: error instanceof Error ? error.message : "Unknown error",
        modelId,
        timeWindowSeconds
      });

      return { requestCount: 0, errorCount: 0, errorRate: 0 };
    }
  }

  /**
   * Automatically trip circuit breaker
   */
  private async tripCircuitBreaker(modelId: string, reason: string): Promise<void> {
    await this.updateCircuitState(modelId, {
      disabled: true,
      reason,
      updatedBy: 'SYSTEM',
      updatedAt: new Date().toISOString(),
      lastTripped: new Date().toISOString()
    });

    // Create audit log
    await this.createAuditLog({
      operation: 'CIRCUIT_OPEN',
      modelId,
      operator: 'SYSTEM',
      reason,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Update circuit breaker state
   */
  private async updateCircuitState(
    modelId: string, 
    updates: Partial<CircuitBreakerState>
  ): Promise<void> {
    try {
      await this.dataClient.models.ModelCircuitBreaker.update({
        id: modelId,  // Fixed: use id instead of modelId
        ...updates
      });

      logger.debug("Circuit breaker state updated", {
        modelId,
        updates
      });

    } catch (error) {
      logger.error("Failed to update circuit breaker state", {
        error: error instanceof Error ? error.message : "Unknown error",
        modelId,
        updates
      });
      throw error;
    }
  }

  /**
   * Create audit log entry
   */
  private async createAuditLog(entry: {
    operation: string;
    modelId: string;
    operator: string;
    reason: string;
    timestamp: string;
  }): Promise<void> {
    try {
      await this.dataClient.models.AuditLog.create({
        operationId: randomUUID(),
        operation: entry.operation as 'CREATE' | 'DEPLOY' | 'ROLLBACK' | 'UPDATE' | 'DELETE' | 'CIRCUIT_OPEN' | 'CIRCUIT_CLOSE',
        modelId: entry.modelId,
        operator: entry.operator,
        reason: entry.reason,
        correlationId: randomUUID(), // Always generate a new UUID for audit logs
        timestamp: entry.timestamp,
      });

    } catch (error) {
      logger.error("Failed to create audit log", {
        error: error instanceof Error ? error.message : "Unknown error",
        entry
      });
      // Don't throw - audit log failure shouldn't stop circuit breaker operations
    }
  }

  /**
   * Get circuit breaker statistics
   */
  async getCircuitStats(): Promise<{
    totalCircuits: number;
    openCircuits: number;
    healthyCircuits: number;
  }> {
    try {
      const allCircuits = await this.dataClient.models.ModelCircuitBreaker.list();
      
      const totalCircuits = allCircuits.data?.length || 0;
      const openCircuits = allCircuits.data?.filter(c => c.disabled).length || 0;
      const healthyCircuits = totalCircuits - openCircuits;

      return {
        totalCircuits,
        openCircuits,
        healthyCircuits
      };

    } catch (error) {
      logger.error("Failed to get circuit stats", {
        error: error instanceof Error ? error.message : "Unknown error"
      });

      return {
        totalCircuits: 0,
        openCircuits: 0,
        healthyCircuits: 0
      };
    }
  }
}