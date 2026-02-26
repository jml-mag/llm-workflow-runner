// amplify/functions/workflow-runner/src/prompt-engine/index.ts

import { Logger } from "@aws-lambda-powertools/logger";
import type { 
  PromptEngineConfig, 
  PromptEngineResult, 
  PromptSegment, 
  InterpolationContext,
  BasePrompt,
  TruncationResult
} from "./types";
import { PromptEngineError } from "./types";
import { BasePromptManager } from "./managers/BasePromptManager";
import { TokenManager } from "./managers/TokenManager";
import { MemoryManager } from "./managers/MemoryManager";
import { VariableInterpolator } from "./processors/VariableInterpolator";
import { MessageFormatter } from "./processors/MessageFormatter";
import { calculateUtilization } from "./utils/tokenization";

const logger = new Logger({ serviceName: "PromptEngine" });

export class PromptEngine {
  constructor(
    private basePromptManager: BasePromptManager,
    private tokenManager: TokenManager,
    private memoryManager: MemoryManager,
    private interpolator: VariableInterpolator,
    private messageFormatter: MessageFormatter
  ) {
    logger.info("PromptEngine initialized");
  }

  /**
   * Main entry point - build complete prompt with all processing steps
   */
  async buildPrompt(config: PromptEngineConfig): Promise<PromptEngineResult> {
    const startTime = Date.now();
    const { workflowState, dataClient, modelConfig, stepPrompt, useMemory, memorySize } = config;

    logger.info("Starting prompt build", {
      workflowId: workflowState.workflowId,
      conversationId: workflowState.conversationId,
      modelId: modelConfig.id,
      useMemory: !!useMemory,
      memorySize: memorySize || 10,
      hasStepPrompt: !!stepPrompt
    });

    try {
      // Step 1: Load base prompt
      const basePrompt = await this.basePromptManager.getBasePrompt(
        dataClient,
        workflowState.workflowId,
        modelConfig.id
      );

      logger.debug("Base prompt loaded", {
        promptId: basePrompt.id,
        version: basePrompt.version,
        contentLength: basePrompt.content.length,
        workflowSpecific: !!basePrompt.workflowId
      });

      // Step 2: Create interpolation context
      const interpolationContext = this.createInterpolationContext(workflowState, modelConfig);

      // Step 3: Interpolate base prompt
      const interpolatedBasePrompt = this.interpolator.interpolate(
        basePrompt.content, 
        interpolationContext
      );

      // Step 4: Interpolate step prompt if provided
      let interpolatedStepPrompt = "";
      if (stepPrompt && stepPrompt.trim()) {
        interpolatedStepPrompt = this.interpolator.interpolate(
          stepPrompt.trim(),
          interpolationContext
        );
      }

      // Step 5: Load conversation memory if enabled
      let memorySegments: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (useMemory) {
        memorySegments = await this.memoryManager.loadConversationMemory(
          dataClient,
          workflowState.conversationId,
          memorySize || 10
        );
      }

      // Step 6: Assemble all prompt segments
      const segments = this.assemblePromptSegments(
        interpolatedBasePrompt,
        interpolatedStepPrompt,
        memorySegments,
        workflowState.userPrompt || ""
      );

      logger.debug("Prompt segments assembled", {
        totalSegments: segments.length,
        systemSegments: segments.filter(s => s.role === "system").length,
        memorySegments: segments.filter(s => s.role === "user" || s.role === "assistant").length - 1,
        userSegments: 1
      });

      // Step 7: Apply token truncation
      const truncationResult = this.tokenManager.truncateToFit(segments);

      if (truncationResult.wasTruncated) {
        logger.warn("Prompt was truncated", {
          originalSegments: segments.length,
          finalSegments: truncationResult.truncatedSegments.length,
          removedSegments: truncationResult.removedSegments || 0
        });
      }

      // Step 8: Format for LangChain
      const messages = this.messageFormatter.formatMessages(truncationResult.truncatedSegments);

      // Step 9: Generate comprehensive metadata
      const metadata = this.generateMetadata(
        basePrompt,
        truncationResult,
        memorySegments.length,
        startTime,
        modelConfig
      );

      const buildTime = Date.now() - startTime;

      logger.info("Prompt build completed successfully", {
        workflowId: workflowState.workflowId,
        conversationId: workflowState.conversationId,
        finalMessageCount: messages.length,
        totalTokens: metadata.totalTokens,
        utilization: metadata.contextUtilization,
        wasTruncated: metadata.wasTruncated,
        buildTime,
        basePromptVersion: metadata.basePromptVersion
      });

      return {
        messages,
        metadata: {
          ...metadata,
          buildTimeMs: buildTime
        }
      };

    } catch (error) {
      const buildTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      logger.error("Prompt build failed", {
        error: errorMessage,
        workflowId: workflowState.workflowId,
        conversationId: workflowState.conversationId,
        modelId: modelConfig.id,
        buildTime
      });

      // Create structured error
      const promptError = new PromptEngineError(
        `Prompt build failed: ${errorMessage}`,
        'PROMPT_BUILD_FAILED',
        {
          workflowId: workflowState.workflowId,
          conversationId: workflowState.conversationId,
          modelId: modelConfig.id,
          buildTime,
          originalError: errorMessage
        }
      );

      throw promptError;
    }
  }

  /**
   * Create interpolation context from workflow state
   */
  private createInterpolationContext(
    workflowState: PromptEngineConfig['workflowState'],
    modelConfig: PromptEngineConfig['modelConfig']
  ): InterpolationContext {
    return {
      workflowState,
      workflowId: workflowState.workflowId || "",
      conversationId: workflowState.conversationId || "",
      userId: workflowState.userId || "",
      nodeId: workflowState.currentNodeId || "",
      nodeType: workflowState.currentNodeType || "",
      slots: workflowState.slotValues || {},
      intent: workflowState.intent || "",
      timestamp: new Date().toISOString(),
      model: {
        id: modelConfig.id,
        provider: modelConfig.provider,
        displayName: modelConfig.displayName
      }
    };
  }

  /**
   * Assemble prompt segments in correct order
   */
  private assemblePromptSegments(
    basePrompt: string,
    stepPrompt: string,
    memorySegments: Array<{ role: "user" | "assistant"; content: string }>,
    userInput: string
  ): PromptSegment[] {
    const segments: PromptSegment[] = [];

    // System message (base + step combined)
    let systemContent = basePrompt;
    if (stepPrompt) {
      systemContent = systemContent + "\n\n" + stepPrompt;
    }
    
    if (systemContent.trim()) {
      segments.push({
        role: "system",
        content: systemContent.trim()
      });
    }

    // Memory segments (conversation history)
    memorySegments.forEach(memory => {
      segments.push({
        role: memory.role,
        content: memory.content
      });
    });

    // Current user input
    if (userInput && userInput.trim()) {
      segments.push({
        role: "user",
        content: userInput.trim()
      });
    }

    return segments;
  }

  /**
   * Generate comprehensive metadata for the result
   */
  private generateMetadata(
    basePrompt: BasePrompt,
    truncationResult: TruncationResult,
    memoryCount: number,
    startTime: number,
    modelConfig: PromptEngineConfig['modelConfig']
  ) {
    const segmentBreakdown = {
      system: truncationResult.truncatedSegments.filter((s: PromptSegment) => s.role === "system").length,
      memory: truncationResult.truncatedSegments.filter((s: PromptSegment) => s.role === "user" || s.role === "assistant").length - 1,
      user: 1
    };

    return {
      totalTokens: truncationResult.totalTokens,
      contextUtilization: calculateUtilization(truncationResult.totalTokens, modelConfig.contextWindow),
      wasTruncated: truncationResult.wasTruncated,
      basePromptVersion: basePrompt.version,
      memoryEntriesLoaded: memoryCount,
      segmentBreakdown,
      truncationDetails: truncationResult.truncationDetails,
      cacheHit: false // Would need to be tracked separately
    };
  }

  /**
   * Static factory method for easy instantiation
   */
  static create(modelConfig: PromptEngineConfig['modelConfig']): PromptEngine {
    return new PromptEngine(
      new BasePromptManager(),
      new TokenManager(modelConfig),
      new MemoryManager(),
      new VariableInterpolator(),
      new MessageFormatter()
    );
  }

  /**
   * Validate configuration before processing
   */
  static validateConfig(config: PromptEngineConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.workflowState) {
      errors.push("workflowState is required");
    } else {
      if (!config.workflowState.workflowId) errors.push("workflowState.workflowId is required");
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

  /**
   * Get engine statistics for monitoring
   */
  getEngineStats() {
    // Create a public interface for engine stats instead of casting
    const tokenManager = this.tokenManager as TokenManager;
    return {
      basePromptCacheStats: this.basePromptManager.getCacheStats(),
      memoryCacheStats: this.memoryManager.getCacheStats(),
      tokenManagerStats: tokenManager.getUtilizationStats([]) // Pass empty array for stats
    };
  }
}

// Export main class and factory function
export default PromptEngine;

/**
 * Convenience function for one-off prompt building
 */
export async function buildPrompt(config: PromptEngineConfig): Promise<PromptEngineResult> {
  const validation = PromptEngine.validateConfig(config);
  if (!validation.isValid) {
    throw new PromptEngineError(
      `Invalid configuration: ${validation.errors.join(", ")}`,
      'INVALID_CONFIG',
      { errors: validation.errors }
    );
  }

  const engine = PromptEngine.create(config.modelConfig);
  return engine.buildPrompt(config);
}