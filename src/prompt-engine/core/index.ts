// amplify/functions/workflow-runner/src/prompt-engine/core/index.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import type { BaseMessage } from "@langchain/core/messages";
import type { Schema } from "@platform/data/resource";
import type { State } from "../../types";
import type { ModelCapability } from "../../modelCapabilities";

import { PointerResolver } from "../managers/PointerResolver";
import { ContentManager } from "../managers/ContentManager";  
import { MemoryManager } from "../managers/MemoryManager";
import { TokenBudget } from "../managers/TokenBudget";
import { PIIScrubber, SecureLogger } from "../processors/Security";
import { Interpolator, InterpolationContext } from "../processors/Interpolator";
import { UnicodeSafeTruncation } from "../processors/Truncation";
import { MessageFormatter } from "../processors/MessageFormatter";
import { CircuitBreaker } from "../circuit-breaker/CircuitBreaker";
import { correlationContext } from "../utils/correlation";

const logger = new Logger({ serviceName: "PromptEngine.Core" });
const metrics = new Metrics({ serviceName: "PromptEngine.Core" });

// Core types for the production prompt engine
export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

export interface PromptEngineConfig {
  workflowState: State;
  dataClient: DataClient;
  modelConfig: ModelCapability;
  tenantId?: string;
  useMemory?: boolean;
  memorySize?: number;
  stepPrompt?: string;
  /** Optional: node-level desired output format; used to gate JSON-only bases */
  outputFormat?: "text" | "markdown" | "json";
}

export interface PromptBuildResult {
  messages: BaseMessage[];
  metadata: {
    totalTokens: number;
    contextWindow: number;
    utilizationPercent: number;
    wasTruncated: boolean;
    removedSegments?: number;
    segmentCounts: {
      system: number;
      memory: number; 
      user: number;
    };
    buildTimeMs: number;
    correlationId: string;
    basePromptVersion: string;
    cacheHit: boolean;
    piiDetected: boolean;
    integrityVerified: boolean;
    costEstimate: number;
    circuitBreakerState: 'closed' | 'open' | 'half-open';
    shouldUseBasePrompt: boolean;
    basePromptSkipReason?: string;
  };
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface TruncationResult {
  preservedTurns: ConversationTurn[];
  droppedTurns: ConversationTurn[];
  finalTokenCount: number;
  truncated: boolean;
}

export class PromptEngineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PromptEngineError';
  }
}

/**
 * Production-Ready Prompt Engine
 * 
 * Features:
 * - Immutable version control with atomic rollouts
 * - PII scrubbing and secure logging
 * - Unicode-safe truncation
 * - Circuit breaker protection
 * - Cost caps and budget validation
 * - Complete audit trail
 * - Multi-tenant security
 * - Smart base prompt gating based on output format
 * - Tone and style interpolation support
 */
export class PromptEngine {
  private readonly pointerResolver: PointerResolver;
  private readonly contentManager: ContentManager;
  private readonly memoryManager: MemoryManager;
  private readonly tokenBudget: TokenBudget;
  private readonly piiScrubber: PIIScrubber;
  private readonly secureLogger: SecureLogger;
  private readonly interpolator: Interpolator;
  private readonly truncation: UnicodeSafeTruncation;
  private readonly formatter: MessageFormatter;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(private readonly dataClient: DataClient) {
    this.pointerResolver = new PointerResolver(dataClient);
    this.contentManager = new ContentManager(dataClient);
    this.memoryManager = new MemoryManager(dataClient);
    this.tokenBudget = new TokenBudget();
    this.piiScrubber = new PIIScrubber();
    this.secureLogger = new SecureLogger();
    this.interpolator = new Interpolator();
    this.truncation = new UnicodeSafeTruncation();
    this.formatter = new MessageFormatter();
    this.circuitBreaker = new CircuitBreaker(dataClient);

    logger.info("Production PromptEngine initialized with security features");
  }

  /**
   * Main entry point - builds complete prompt with enterprise safeguards
   */
  async buildPrompt(config: PromptEngineConfig): Promise<PromptBuildResult> {
    const startTime = Date.now();
    const correlationId = correlationContext.getCorrelationId();

    this.secureLogger.info("Prompt build initiated", {
      workflowId: config.workflowState.workflowId,
      conversationId: config.workflowState.conversationId,
      modelId: config.modelConfig.id,
      useMemory: !!config.useMemory,
      memorySize: config.memorySize || 10,
    }, correlationId);

    try {
      // Step 1: Circuit breaker check
      const circuitCheck = await this.circuitBreaker.checkModelHealth(config.modelConfig.id);
      if (!circuitCheck.healthy) {
        throw new PromptEngineError(
          `Model circuit breaker open: ${circuitCheck.reason}`,
          'CIRCUIT_BREAKER_OPEN',
          { modelId: config.modelConfig.id, reason: circuitCheck.reason }
        );
      }

      // Step 2: Determine output format
      const nodeOutputFormat = this.resolveOutputFormat(config);

      // Step 3: Decide whether to use base prompt (JSON-only gating)
      const shouldUseBasePrompt = nodeOutputFormat === "json";
      let basePromptVersionId: string | undefined;
      let baseContent = "";
      let integrityVerified = true;
      let basePromptSkipReason: string | undefined;

      if (shouldUseBasePrompt) {
        // Resolve active prompt version only for JSON nodes
        const activePrompt = await this.pointerResolver.resolveActivePrompt(
          config.workflowState.workflowId || null,
          config.modelConfig.id,
          config.tenantId || null
        );

        basePromptVersionId = activePrompt?.id;

        if (basePromptVersionId) {
          // Content integrity verification
          integrityVerified = await this.contentManager.verifyContentIntegrity(activePrompt);
          if (!integrityVerified) {
            throw new PromptEngineError(
              'Content integrity violation detected',
              'INTEGRITY_VIOLATION',
              { versionId: basePromptVersionId }
            );
          }

          // Get prompt content
          baseContent = await this.contentManager.getContent(activePrompt);
        }
      } else {
        basePromptSkipReason = `outputFormat=${nodeOutputFormat}, base prompts only used for JSON`;
      }

      logger.info("PromptEngine: base selection", {
        outputFormat: nodeOutputFormat,
        shouldUseBasePrompt,
        basePromptVersionId: basePromptVersionId ?? null,
        reason: shouldUseBasePrompt ? "outputFormat==json" : "text_mode_skip_base",
      });

      // Step 4: Build interpolation context with tone/style support
      const interpolationContext = this.buildInterpolationContext(config, correlationId);

      // Step 5: Interpolate base prompt (with PII scrubbing)
      let interpolatedBase = "";
      let piiDetectedInBase = false;
      
      if (baseContent) {
        interpolatedBase = this.interpolator.interpolate(baseContent, interpolationContext);
        piiDetectedInBase = this.piiScrubber.detectPII(interpolatedBase);
      }

      // Step 6: Interpolate step prompt if provided
      let interpolatedStep = "";
      let piiDetectedInStep = false;
      if (config.stepPrompt?.trim()) {
        interpolatedStep = this.interpolator.interpolate(config.stepPrompt.trim(), interpolationContext);
        piiDetectedInStep = this.piiScrubber.detectPII(interpolatedStep);
      }

      // Step 7: Load conversation memory with PII scrubbing
      let memoryTurns: ConversationTurn[] = [];
      let piiDetectedInMemory = false;
      if (config.useMemory) {
        const rawMemory = await this.memoryManager.loadConversationMemory(
          this.dataClient,
          config.workflowState.conversationId,
          config.memorySize || 10
        );

        // Scrub PII from memory content
        memoryTurns = rawMemory.map(turn => ({
          ...turn,
          content: this.piiScrubber.scrubContent(turn.content)
        }));

        piiDetectedInMemory = rawMemory.some(turn => this.piiScrubber.detectPII(turn.content));
      }

      // Step 8: Build complete prompt segments
      const segments = this.buildPromptSegments(
        this.piiScrubber.scrubContent(interpolatedBase),
        this.piiScrubber.scrubContent(interpolatedStep),
        memoryTurns,
        this.piiScrubber.scrubContent(config.workflowState.userPrompt || "")
      );

      // Step 9: Token budget validation with cost caps
      const totalTokenEstimate = this.estimateTotalTokens(segments, config.modelConfig);
      const budgetResult = this.tokenBudget.enforce(
        config.modelConfig, 
        config.modelConfig.reservedOutputTokens || 2000,
        totalTokenEstimate
      );

      // Step 10: Unicode-safe truncation
      const truncationResult = this.truncation.truncateToTokenBudget(memoryTurns, budgetResult.availableInputTokens);
      
      // Rebuild segments with truncated memory
      const finalSegments = this.buildPromptSegments(
        this.piiScrubber.scrubContent(interpolatedBase),
        this.piiScrubber.scrubContent(interpolatedStep),
        truncationResult.preservedTurns,
        this.piiScrubber.scrubContent(config.workflowState.userPrompt || "")
      );

      // Step 11: Format for LangChain
      const messages = this.formatter.formatMessages(finalSegments);

      // Step 12: Calculate final metrics
      const finalTokenCount = this.estimateTotalTokens(finalSegments, config.modelConfig);
      const utilizationPercent = Math.round((finalTokenCount / config.modelConfig.contextWindow) * 100);

      const buildTime = Date.now() - startTime;

      const metadata: PromptBuildResult['metadata'] = {
        totalTokens: finalTokenCount,
        contextWindow: config.modelConfig.contextWindow,
        utilizationPercent,
        wasTruncated: truncationResult.truncated,
        removedSegments: truncationResult.droppedTurns.length,
        segmentCounts: {
          system: finalSegments.filter(s => s.role === "system").length,
          memory: truncationResult.preservedTurns.length,
          user: 1
        },
        buildTimeMs: buildTime,
        correlationId,
        basePromptVersion: basePromptVersionId || "none",
        cacheHit: this.pointerResolver.wasCacheHit(),
        piiDetected: piiDetectedInBase || piiDetectedInStep || piiDetectedInMemory,
        integrityVerified,
        costEstimate: budgetResult.estimatedCost,
        circuitBreakerState: 'closed' as const,
        shouldUseBasePrompt,
        basePromptSkipReason,
      };

      // Record success metrics
      metrics.addMetric('PromptBuildSuccess', MetricUnit.Count, 1);
      metrics.addMetric('PromptBuildLatency', MetricUnit.Milliseconds, buildTime);
      metrics.addMetric('TokenUsage', MetricUnit.Count, finalTokenCount);
      
      if (shouldUseBasePrompt) {
        metrics.addMetric('BasePromptUsed', MetricUnit.Count, 1);
      } else {
        metrics.addMetric('BasePromptSkipped', MetricUnit.Count, 1);
      }

      if (metadata.piiDetected) {
        metrics.addMetric('PIIDetected', MetricUnit.Count, 1);
      }

      this.secureLogger.info("Prompt build completed successfully", {
        finalMessageCount: messages.length,
        totalTokens: finalTokenCount,
        utilization: utilizationPercent,
        wasTruncated: metadata.wasTruncated,
        buildTime,
        basePromptVersion: metadata.basePromptVersion,
        shouldUseBasePrompt,
        piiDetected: metadata.piiDetected,
        costEstimate: metadata.costEstimate
      }, correlationId);

      return { messages, metadata };

    } catch (error) {
      const buildTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      // Record failure metrics
      metrics.addMetric('PromptBuildFailure', MetricUnit.Count, 1);
      metrics.addMetric('PromptBuildLatency', MetricUnit.Milliseconds, buildTime);

      this.secureLogger.info("Prompt build failed", {
        error: errorMessage,
        workflowId: config.workflowState.workflowId,
        conversationId: config.workflowState.conversationId,
        modelId: config.modelConfig.id,
        buildTime
      }, correlationId);

      // Re-throw as structured error
      if (error instanceof PromptEngineError) {
        throw error;
      }

      throw new PromptEngineError(
        `Prompt build failed: ${errorMessage}`,
        'PROMPT_BUILD_FAILED',
        {
          workflowId: config.workflowState.workflowId,
          conversationId: config.workflowState.conversationId,
          modelId: config.modelConfig.id,
          buildTime,
          originalError: errorMessage
        }
      );
    }
  }

  /**
   * Resolve the effective output format from configuration hierarchy
   */
  private resolveOutputFormat(config: PromptEngineConfig): "text" | "markdown" | "json" {
    return (
      config.outputFormat ??
      config.workflowState?.currentNodeConfig?.outputFormat ??
      "text"
    );
  }

  /**
   * Build interpolation context from workflow state
   * Now includes tone and style for {{tone}} and {{style}} template variables
   */
  private buildInterpolationContext(config: PromptEngineConfig, correlationId: string): InterpolationContext {
    const baseContext: InterpolationContext = {
      workflowState: config.workflowState,
      workflowId: config.workflowState.workflowId || "",
      conversationId: config.workflowState.conversationId || "",
      userId: config.workflowState.userId || "",
      nodeId: config.workflowState.currentNodeId || "",
      nodeType: config.workflowState.currentNodeType || "",
      slots: config.workflowState.slotValues || {},
      intent: config.workflowState.intent || "",
      timestamp: new Date().toISOString(),
      correlationId,
      model: {
        id: config.modelConfig.id,
        provider: config.modelConfig.provider,
        displayName: config.modelConfig.displayName
      }
    };

    // Include tone/style for variable interpolation
    try {
      const nodeCfg = config.workflowState.currentNodeConfig ?? {};
      const nodeConfigRecord = nodeCfg as Record<string, unknown>;
      
      if (typeof nodeConfigRecord.style === "string" && nodeConfigRecord.style.trim()) {
        (baseContext as Record<string, unknown>).style = nodeConfigRecord.style.trim();
      }
      
      if (typeof nodeConfigRecord.tone === "string" && nodeConfigRecord.tone.trim()) {
        (baseContext as Record<string, unknown>).tone = nodeConfigRecord.tone.trim();
      }

      const ctx = baseContext as Record<string, unknown>;
      if (ctx.tone || ctx.style) {
        logger.info("[PromptEngine] Tone/Style added to interpolation context", {
          tone: ctx.tone || "(none)",
          style: ctx.style || "(none)"
        });
      }
    } catch (err) {
      logger.warn("Tone/style interpolation enrichment failed", { error: err });
    }

    return baseContext;
  }

  /**
   * Build prompt segments in correct order with stepPrompt priority
   */
  private buildPromptSegments(
    basePrompt: string,
    stepPrompt: string,
    memoryTurns: ConversationTurn[],
    userInput: string
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const segments: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

    // NEW behavior: Choose a single system message in priority order:
    // 1) stepPrompt (node-provided systemPrompt) - highest priority
    // 2) basePrompt (when present; typically JSON base when explicitly requested)
    // 3) default system (safe fallback)
    const defaultSystem = "You are a helpful AI assistant.";
    const chosenSystem =
      (stepPrompt && stepPrompt.trim().length > 0)
        ? stepPrompt.trim()
        : (basePrompt && basePrompt.trim().length > 0)
          ? basePrompt.trim()
          : defaultSystem;

    segments.push({
      role: "system",
      content: chosenSystem
    });

    // Memory segments (conversation history)
    memoryTurns.forEach(memory => {
      segments.push({
        role: memory.role,
        content: memory.content
      });
    });

    // Current user input
    if (userInput?.trim()) {
      segments.push({
        role: "user",
        content: userInput.trim()
      });
    }

    return segments;
  }

  /**
   * Estimate total tokens for segments (simplified implementation)
   */
  private estimateTotalTokens(
    segments: Array<{ content: string }>, 
    modelConfig: ModelCapability
  ): number {
    const totalChars = segments.reduce((sum, segment) => sum + segment.content.length, 0);
    
    // Provider-specific token estimation
    const charsPerToken = modelConfig.provider === 'anthropic' ? 3.5 :
                         modelConfig.provider === 'amazon' ? 4.2 : 
                         modelConfig.provider === 'meta' ? 3.8 : 4.0;
    
    const baseTokens = Math.ceil(totalChars / charsPerToken);
    const overheadTokens = segments.length * 10; // Message formatting overhead
    
    return baseTokens + overheadTokens;
  }

  /**
   * Static factory method for easy instantiation
   */
  static create(dataClient: DataClient): PromptEngine {
    return new PromptEngine(dataClient);
  }

  /**
   * Validate configuration before processing
   */
  static validateConfig(config: PromptEngineConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.workflowState) {
      errors.push("workflowState is required");
    } else {
      if (!config.workflowState.conversationId) errors.push("workflowState.conversationId is required");
      if (!config.workflowState.userId) errors.push("workflowState.userId is required");
    }

    if (!config.dataClient) {
      errors.push("dataClient is required");
    }

    if (!config.modelConfig) {
      errors.push("modelConfig is required");
    } else {
      if (!config.modelConfig.id) errors.push("modelConfig.id is required");
      if (!config.modelConfig.contextWindow) errors.push("modelConfig.contextWindow is required");
    }

    if (config.memorySize !== undefined && (config.memorySize < 0 || config.memorySize > 100)) {
      errors.push("memorySize must be between 0 and 100");
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}