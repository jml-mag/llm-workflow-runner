// amplify/functions/workflow-runner/src/prompt-engine/managers/TokenManager.ts

import { Logger } from "@aws-lambda-powertools/logger";
import type { ModelCapability } from "../../modelCapabilities";
import type { 
  PromptSegment, 
  TruncationResult, 
  TruncationMetadata, 
  TokenizationConfig 
} from "../types";
import { 
  createTokenizationConfig, 
  estimateTokens, 
  estimateTokensForSegments,
  calculateUtilization,
  wouldExceedContext,
  getAvailableTokens,
  estimateCharsForTokens
} from "../utils/tokenization";

const logger = new Logger({ serviceName: "PromptEngine.TokenManager" });

export class TokenManager {
  private tokenConfig: TokenizationConfig;
  private contextWindow: number;
  private bufferPercent: number;

  constructor(
    private modelConfig: ModelCapability,
    bufferPercent: number = 10
  ) {
    this.tokenConfig = createTokenizationConfig(modelConfig);
    this.contextWindow = modelConfig.contextWindow;
    this.bufferPercent = bufferPercent;

    logger.info("TokenManager initialized", {
      modelId: modelConfig.id,
      provider: modelConfig.provider,
      contextWindow: this.contextWindow,
      bufferPercent: this.bufferPercent
    });
  }

  /**
   * Main truncation method - implements intelligent priority-based truncation
   * Strategy:
   * 1. Always preserve system prompt and current user input
   * 2. Remove oldest memory entries first
   * 3. As last resort, truncate system prompt
   */
  truncateToFit(segments: PromptSegment[]): TruncationResult {
    const startTime = Date.now();
    
    if (segments.length === 0) {
      return {
        truncatedSegments: [],
        totalTokens: 0,
        wasTruncated: false
      };
    }

    logger.info("Starting intelligent truncation", {
      initialSegments: segments.length,
      contextWindow: this.contextWindow,
      bufferPercent: this.bufferPercent
    });

    const workingSegments = [...segments];
    const totalTokens = this.calculateTotalTokens(workingSegments);
    const maxAllowedTokens = this.getMaxAllowedTokens();

    // If we're within limits, no truncation needed
    if (totalTokens <= maxAllowedTokens) {
      const processingTime = Date.now() - startTime;
      logger.info("No truncation needed", {
        totalTokens,
        maxAllowedTokens,
        utilization: calculateUtilization(totalTokens, this.contextWindow),
        processingTime
      });

      return {
        truncatedSegments: workingSegments,
        totalTokens,
        wasTruncated: false
      };
    }

    // Apply truncation strategies in order of priority
    const truncationResult = this.applyTruncationStrategies(workingSegments, maxAllowedTokens);
    
    const processingTime = Date.now() - startTime;
    logger.info("Truncation completed", {
      ...truncationResult,
      processingTime,
      utilization: calculateUtilization(truncationResult.totalTokens, this.contextWindow)
    });

    return truncationResult;
  }

  /**
   * Apply truncation strategies in priority order
   */
  private applyTruncationStrategies(
    segments: PromptSegment[], 
    maxTokens: number
  ): TruncationResult {
    const originalSegmentCount = segments.length;
    let currentSegments = [...segments];
    let currentTokens = this.calculateTotalTokens(currentSegments);
    let removedMemoryEntries = 0;
    let systemPromptTruncated = false;

    // Strategy 1: Remove memory entries (middle segments)
    // Preserve system prompt (first) and user input (last)
    if (currentTokens > maxTokens && currentSegments.length > 2) {
      const result = this.removeMemoryEntries(currentSegments, maxTokens);
      currentSegments = result.segments;
      currentTokens = result.tokens;
      removedMemoryEntries = result.removedCount;

      logger.info("Memory removal strategy applied", {
        removedEntries: removedMemoryEntries,
        remainingSegments: currentSegments.length,
        tokensAfterRemoval: currentTokens
      });
    }

    // Strategy 2: Truncate system prompt as last resort
    if (currentTokens > maxTokens && currentSegments.length >= 1) {
      const result = this.truncateSystemPrompt(currentSegments, maxTokens);
      currentSegments = result.segments;
      currentTokens = result.tokens;
      systemPromptTruncated = result.wasTruncated;

      if (systemPromptTruncated) {
        logger.warn("System prompt truncated", {
          tokensAfterTruncation: currentTokens,
          maxTokens
        });
      }
    }

    const wasTruncated = removedMemoryEntries > 0 || systemPromptTruncated;
    const strategy = systemPromptTruncated ? 'system_truncation' : 
                    removedMemoryEntries > 0 ? 'memory_removal' : 'none';

    const truncationDetails: TruncationMetadata = {
      originalSegments: originalSegmentCount,
      finalSegments: currentSegments.length,
      removedMemoryEntries,
      systemPromptTruncated,
      strategy
    };

    return {
      truncatedSegments: currentSegments,
      totalTokens: currentTokens,
      wasTruncated,
      removedSegments: removedMemoryEntries,
      truncationDetails
    };
  }

  /**
   * Remove memory entries from oldest to newest
   */
  private removeMemoryEntries(
    segments: PromptSegment[], 
    maxTokens: number
  ): { segments: PromptSegment[]; tokens: number; removedCount: number } {
    if (segments.length <= 2) {
      return { segments, tokens: this.calculateTotalTokens(segments), removedCount: 0 };
    }

    const systemSegment = segments[0];
    const userSegment = segments[segments.length - 1];
    const memorySegments = segments.slice(1, -1);
    let removedCount = 0;

    // Calculate tokens for required segments (system + user)
    const requiredTokens = estimateTokens(systemSegment.content, this.tokenConfig) +
                          estimateTokens(userSegment.content, this.tokenConfig);

    // Remove memory segments until we fit or run out
    const workingMemorySegments = [...memorySegments];
    while (workingMemorySegments.length > 0) {
      const currentMemoryTokens = estimateTokensForSegments(workingMemorySegments, this.tokenConfig);
      const totalTokens = requiredTokens + currentMemoryTokens;

      if (totalTokens <= maxTokens) break;

      // Remove oldest memory entry (first in array)
      workingMemorySegments.shift();
      removedCount++;

      logger.debug("Removed memory segment", {
        removedCount,
        remainingMemorySegments: workingMemorySegments.length,
        currentTokens: requiredTokens + estimateTokensForSegments(workingMemorySegments, this.tokenConfig)
      });
    }

    const finalSegments = [systemSegment, ...workingMemorySegments, userSegment];
    return {
      segments: finalSegments,
      tokens: this.calculateTotalTokens(finalSegments),
      removedCount
    };
  }

  /**
   * Truncate system prompt as last resort
   */
  private truncateSystemPrompt(
    segments: PromptSegment[], 
    maxTokens: number
  ): { segments: PromptSegment[]; tokens: number; wasTruncated: boolean } {
    if (segments.length === 0) {
      return { segments, tokens: 0, wasTruncated: false };
    }

    const systemSegment = segments[0];
    const otherSegments = segments.slice(1);
    const otherTokens = estimateTokensForSegments(otherSegments, this.tokenConfig);
    
    // Calculate available tokens for system prompt
    const availableForSystem = maxTokens - otherTokens - 50; // 50 token safety buffer

    if (availableForSystem < 100) {
      logger.error("Insufficient tokens even after truncation", {
        maxTokens,
        otherTokens,
        availableForSystem,
        minSystemTokens: 100
      });
      // Return minimal system prompt
      const minimalSystem: PromptSegment = {
        role: "system",
        content: "You are a helpful AI assistant."
      };
      return {
        segments: [minimalSystem, ...otherSegments],
        tokens: this.calculateTotalTokens([minimalSystem, ...otherSegments]),
        wasTruncated: true
      };
    }

    // Estimate how many characters we can keep
    const maxSystemChars = estimateCharsForTokens(availableForSystem, this.tokenConfig);
    
    if (systemSegment.content.length <= maxSystemChars) {
      // No truncation needed
      return {
        segments,
        tokens: this.calculateTotalTokens(segments),
        wasTruncated: false
      };
    }

    // Truncate system prompt intelligently
    const truncatedContent = this.intelligentStringTruncation(
      systemSegment.content, 
      maxSystemChars
    );

    const truncatedSystemSegment: PromptSegment = {
      role: "system",
      content: truncatedContent
    };

    const finalSegments = [truncatedSystemSegment, ...otherSegments];

    logger.warn("System prompt truncated", {
      originalLength: systemSegment.content.length,
      truncatedLength: truncatedContent.length,
      maxSystemChars,
      finalTokens: this.calculateTotalTokens(finalSegments)
    });

    return {
      segments: finalSegments,
      tokens: this.calculateTotalTokens(finalSegments),
      wasTruncated: true
    };
  }

  /**
   * Intelligently truncate string at word boundaries when possible
   */
  private intelligentStringTruncation(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;

    // Try to truncate at sentence boundary
    const sentences = content.split(/[.!?]+/);
    let result = '';
    
    for (const sentence of sentences) {
      const potential = result + sentence + '.';
      if (potential.length > maxChars - 20) break; // Leave room for ellipsis
      result = potential;
    }

    if (result.length > 100) {
      return result.trim() + '...';
    }

    // Fall back to word boundary truncation
    const words = content.split(' ');
    result = '';
    
    for (const word of words) {
      const potential = result + ' ' + word;
      if (potential.length > maxChars - 20) break;
      result = potential;
    }

    return result.trim() + '...';
  }

  /**
   * Calculate total tokens for array of segments
   */
  private calculateTotalTokens(segments: PromptSegment[]): number {
    return estimateTokensForSegments(segments, this.tokenConfig);
  }

  /**
   * Get maximum allowed tokens with buffer
   */
  private getMaxAllowedTokens(): number {
    return Math.floor(this.contextWindow * (1 - this.bufferPercent / 100));
  }

  /**
   * Get current utilization stats
   */
  getUtilizationStats(segments: PromptSegment[]) {
    const totalTokens = this.calculateTotalTokens(segments);
    return {
      totalTokens,
      contextWindow: this.contextWindow,
      utilization: calculateUtilization(totalTokens, this.contextWindow),
      availableTokens: getAvailableTokens(totalTokens, this.contextWindow, this.bufferPercent),
      wouldExceed: wouldExceedContext(totalTokens, this.contextWindow, this.bufferPercent)
    };
  }
}