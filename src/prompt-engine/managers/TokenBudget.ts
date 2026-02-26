// amplify/functions/workflow-runner/src/prompt-engine/managers/TokenBudget.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import type { ModelCapability } from "../../modelCapabilities";

const logger = new Logger({ serviceName: "PromptEngine.TokenBudget" });
const metrics = new Metrics({ serviceName: "PromptEngine.TokenBudget" });

interface CostCapConfig {
  maxCostPerRequest: number;    // USD
  maxTokensPerRequest: number;  // Absolute token limit
  emergencyStopThreshold: number; // USD - alerts ops team
}

export interface BudgetResult {
  effectiveOutputTokens: number;
  availableInputTokens: number;
  adjusted: boolean;
  estimatedCost: number;
  withinLimits: boolean;
}

/**
 * Token budget manager with enterprise cost controls
 * Enforces per-request spending limits and emergency thresholds
 */
export class TokenBudget {
  private readonly costCaps: Record<string, CostCapConfig> = {
    'gpt-4o': { 
      maxCostPerRequest: 10.0, 
      maxTokensPerRequest: 50000, 
      emergencyStopThreshold: 50.0 
    },
    'us.anthropic.claude-3-7-sonnet-20250219-v1:0': { 
      maxCostPerRequest: 8.0, 
      maxTokensPerRequest: 100000, 
      emergencyStopThreshold: 40.0 
    },
    'anthropic.claude-3-7-sonnet-20250219-v1:0': { 
      maxCostPerRequest: 8.0, 
      maxTokensPerRequest: 100000, 
      emergencyStopThreshold: 40.0 
    },
    'us.amazon.nova-pro-v1:0': { 
      maxCostPerRequest: 3.0, 
      maxTokensPerRequest: 150000, 
      emergencyStopThreshold: 15.0 
    },
    'amazon.nova-pro-v1:0': { 
      maxCostPerRequest: 3.0, 
      maxTokensPerRequest: 150000, 
      emergencyStopThreshold: 15.0 
    },
    'us.meta.llama4-maverick-17b-instruct-v1:0': { 
      maxCostPerRequest: 2.0, 
      maxTokensPerRequest: 200000, 
      emergencyStopThreshold: 10.0 
    },
    'meta.llama4-maverick-17b-instruct-v1:0': { 
      maxCostPerRequest: 2.0, 
      maxTokensPerRequest: 200000, 
      emergencyStopThreshold: 10.0 
    },
  };

  private readonly DEFAULT_COST_CAP: CostCapConfig = {
    maxCostPerRequest: 5.0,
    maxTokensPerRequest: 100000,
    emergencyStopThreshold: 25.0
  };

  /**
   * Enforce budget constraints and calculate costs
   */
  enforce(
    modelConfig: ModelCapability, 
    requestedOutput: number, 
    inputTokens: number
  ): BudgetResult {
    const startTime = Date.now();

    logger.debug("Enforcing token budget", {
      modelId: modelConfig.id,
      requestedOutput,
      inputTokens,
      contextWindow: modelConfig.contextWindow
    });

    // Get cost cap configuration
    const costCap = this.getCostCap(modelConfig.id);
    
    // Calculate estimated cost with correct pricing units
    const { inputCost, outputCost, totalCost: totalEstimatedCost } = this.calculateCost(
      modelConfig,
      inputTokens,
      requestedOutput
    );

    // Calculate total tokens
    const totalTokens = inputTokens + requestedOutput;

    logger.info("Budget calculation", {
      modelId: modelConfig.id,
      inputTokens,
      requestedOutput,
      totalTokens,
      inputCost,
      outputCost,
      totalEstimatedCost,
      pricingUnit: modelConfig.pricing?.unit,
      costCap: costCap.maxCostPerRequest,
      tokenCap: costCap.maxTokensPerRequest
    });

    // Check absolute token limit
    if (totalTokens > costCap.maxTokensPerRequest) {
      const processingTime = Date.now() - startTime;
      
      logger.error("Token limit exceeded", {
        totalTokens,
        limit: costCap.maxTokensPerRequest,
        modelId: modelConfig.id,
        processingTime
      });

      metrics.addMetric('TokenLimitExceeded', MetricUnit.Count, 1);
      metrics.addMetric('BudgetEnforcementLatency', MetricUnit.Milliseconds, processingTime);

      throw new TokenBudgetError(
        'TOKEN_LIMIT_EXCEEDED',
        `Request ${totalTokens} tokens exceeds limit ${costCap.maxTokensPerRequest}`,
        {
          totalTokens,
          limit: costCap.maxTokensPerRequest,
          modelId: modelConfig.id
        }
      );
    }

    // Check cost limit
    if (totalEstimatedCost > costCap.maxCostPerRequest) {
      const processingTime = Date.now() - startTime;
      
      logger.error("Cost limit exceeded", {
        totalEstimatedCost,
        limit: costCap.maxCostPerRequest,
        modelId: modelConfig.id,
        processingTime
      });

      metrics.addMetric('CostLimitExceeded', MetricUnit.Count, 1);
      metrics.addMetric('BudgetEnforcementLatency', MetricUnit.Milliseconds, processingTime);

      throw new TokenBudgetError(
        'COST_LIMIT_EXCEEDED',
        `Request $${totalEstimatedCost.toFixed(4)} exceeds limit $${costCap.maxCostPerRequest}`,
        {
          totalEstimatedCost,
          limit: costCap.maxCostPerRequest,
          modelId: modelConfig.id
        }
      );
    }

    // Check context window limit
    if (totalTokens > modelConfig.contextWindow) {
      const processingTime = Date.now() - startTime;
      
      logger.error("Context window exceeded", {
        totalTokens,
        contextWindow: modelConfig.contextWindow,
        modelId: modelConfig.id,
        processingTime
      });

      metrics.addMetric('ContextWindowExceeded', MetricUnit.Count, 1);

      throw new TokenBudgetError(
        'CONTEXT_WINDOW_EXCEEDED',
        `Request ${totalTokens} tokens exceeds context window ${modelConfig.contextWindow}`,
        {
          totalTokens,
          contextWindow: modelConfig.contextWindow,
          modelId: modelConfig.id
        }
      );
    }

    // Emergency alert threshold
    if (totalEstimatedCost > costCap.emergencyStopThreshold) {
      this.alertOpsTeam({
        severity: 'HIGH',
        message: 'High-cost request detected',
        estimatedCost: totalEstimatedCost,
        modelId: modelConfig.id,
        threshold: costCap.emergencyStopThreshold,
        inputTokens,
        requestedOutput
      });

      logger.warn("Emergency cost threshold reached", {
        estimatedCost: totalEstimatedCost,
        threshold: costCap.emergencyStopThreshold,
        modelId: modelConfig.id
      });

      metrics.addMetric('EmergencyCostThresholdReached', MetricUnit.Count, 1);
    }

    const processingTime = Date.now() - startTime;
    const availableInputTokens = modelConfig.contextWindow - requestedOutput;

    // Record successful budget enforcement
    metrics.addMetric('BudgetEnforcementSuccess', MetricUnit.Count, 1);
    metrics.addMetric('BudgetEnforcementLatency', MetricUnit.Milliseconds, processingTime);
    metrics.addMetric('EstimatedRequestCost', MetricUnit.NoUnit, totalEstimatedCost); // Fixed: use NoUnit instead of None

    logger.info("Budget enforcement completed", {
      modelId: modelConfig.id,
      totalTokens,
      estimatedCost: totalEstimatedCost,
      withinLimits: true,
      availableInputTokens,
      processingTime
    });

    return {
      effectiveOutputTokens: requestedOutput,
      availableInputTokens,
      adjusted: false,
      estimatedCost: totalEstimatedCost,
      withinLimits: true
    };
  }

  /**
   * Get cost cap configuration for model
   */
  private getCostCap(modelId: string): CostCapConfig {
    // Try exact match first
    if (this.costCaps[modelId]) {
      return this.costCaps[modelId];
    }

    // Try pattern matching for inference profiles
    for (const [pattern, config] of Object.entries(this.costCaps)) {
      if (modelId.includes(pattern) || pattern.includes(modelId.split('.').pop() || '')) {
        logger.debug("Using pattern-matched cost cap", { modelId, pattern });
        return config;
      }
    }

    // Default fallback
    logger.warn("Using default cost cap for unknown model", { modelId });
    return this.DEFAULT_COST_CAP;
  }

  /**
   * Alert operations team about high-cost requests - Fixed: proper metric dimensions
   */
  private alertOpsTeam(alert: {
    severity: 'HIGH' | 'CRITICAL';
    message: string;
    estimatedCost: number;
    modelId: string;
    threshold: number;
    inputTokens: number;
    requestedOutput: number;
  }): void {
    try {
      // In production, this would integrate with SNS, PagerDuty, etc.
      logger.error("OPS ALERT", {
        ...alert,
        timestamp: new Date().toISOString(),
        alertType: 'HIGH_COST_REQUEST'
      });

      // Fixed: Use proper metric dimensions format
      metrics.addMetric('OpsAlertTriggered', MetricUnit.Count, 1);
      metrics.addMetadata('severity', alert.severity);
      metrics.addMetadata('modelId', alert.modelId);

      // TODO: Implement actual alerting mechanism
      // await sns.publish({
      //   TopicArn: process.env.OPS_ALERT_TOPIC_ARN,
      //   Message: JSON.stringify(alert),
      //   Subject: `HIGH COST REQUEST: ${alert.modelId}`
      // });

    } catch (error) {
      logger.error("Failed to send ops alert", {
        error: error instanceof Error ? error.message : "Unknown error",
        alert
      });
    }
  }

  /**
   * Calculate cost for given token usage
   */
  calculateCost(
    modelConfig: ModelCapability,
    inputTokens: number,
    outputTokens: number
  ): {
    inputCost: number;
    outputCost: number;
    totalCost: number;
  } {
    const unit = modelConfig.pricing?.unit;
    const inRate  = modelConfig.pricing?.inputCostPerUnit  ?? 0;
    const outRate = modelConfig.pricing?.outputCostPerUnit ?? 0;

    let inputCost = 0;
    let outputCost = 0;

    switch (unit) {
      case '1K tokens': {
        inputCost  = (inputTokens  / 1000) * inRate;
        outputCost = (outputTokens / 1000) * outRate;
        break;
      }
      case 'minute': {
        // If you ever meter by minutes, compute minutes upstream and pass as tokens=minutes
        inputCost  = 0;
        outputCost = outRate; // placeholder — adjust to your minute accounting if used
        break;
      }
      case 'image':
      case 'call': {
        // Flat/request units: treat passed "tokens" as count=1
        inputCost  = inRate;
        outputCost = outRate;
        break;
      }
      default: {
        // Conservative fallback: assume per-1K if unspecified
        inputCost  = (inputTokens  / 1000) * inRate;
        outputCost = (outputTokens / 1000) * outRate;
      }
    }

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost
    };
  }

  /**
   * Check if request would exceed budget without throwing
   */
  wouldExceedBudget(
    modelConfig: ModelCapability,
    inputTokens: number,
    outputTokens: number
  ): {
    exceedsTokenLimit: boolean;
    exceedsCostLimit: boolean;
    exceedsContextWindow: boolean;
    estimatedCost: number;
    totalTokens: number;
  } {
    const costCap = this.getCostCap(modelConfig.id);
    const { totalCost } = this.calculateCost(modelConfig, inputTokens, outputTokens);
    const totalTokens = inputTokens + outputTokens;

    return {
      exceedsTokenLimit: totalTokens > costCap.maxTokensPerRequest,
      exceedsCostLimit: totalCost > costCap.maxCostPerRequest,
      exceedsContextWindow: totalTokens > modelConfig.contextWindow,
      estimatedCost: totalCost,
      totalTokens
    };
  }

  /**
   * Get budget statistics for monitoring
   */
  getBudgetStats(modelId: string): {
    costCap: CostCapConfig;
    isDefaultCap: boolean;
  } {
    const costCap = this.getCostCap(modelId);
    const isDefaultCap = !this.costCaps[modelId];

    return {
      costCap,
      isDefaultCap
    };
  }
}

/**
 * Structured error for budget violations
 */
export class TokenBudgetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TokenBudgetError';
  }
}