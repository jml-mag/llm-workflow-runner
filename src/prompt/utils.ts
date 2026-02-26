// amplify/functions/workflow-runner/src/prompt/utils.ts
import type { PromptSegment, TruncationResult } from "./types";
import type { ModelCapability } from "../modelCapabilities";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "PromptEngine.Utils" });

/**
 * Rough token estimation for text (approximation: 1 token ≈ 4 characters)
 * This is a simplified estimation - production systems should use model-specific tokenizers
 */
function estimateTokens(content: string): number {
  // Simple approximation: average 4 characters per token
  // Add some buffer for message formatting overhead
  const baseTokens = Math.ceil(content.length / 4);
  const formatOverhead = 10; // Buffer for message role formatting
  return baseTokens + formatOverhead;
}

/**
 * Calculate total tokens for an array of prompt segments
 */
function calculateTotalTokens(segments: PromptSegment[]): number {
  return segments.reduce((total, segment) => {
    return total + estimateTokens(segment.content);
  }, 0);
}

/**
 * Truncate prompt segments to fit within model context window
 * 
 * Strategy:
 * 1. Always preserve system prompt (index 0)
 * 2. Always preserve user prompt (last index)
 * 3. Remove memory segments from oldest to newest if needed
 * 4. If still too large, truncate system prompt as last resort
 * 
 * @param segments - Array of prompt segments to truncate
 * @param modelConfig - Model configuration with context window info
 * @returns TruncationResult with truncated segments and metadata
 */
export function truncateToFitContextWindow(
  segments: PromptSegment[],
  modelConfig: ModelCapability
): TruncationResult {
  const contextWindow = modelConfig.contextWindow;
  const reserveTokens = Math.floor(contextWindow * 0.1); // Reserve 10% for response
  const maxPromptTokens = contextWindow - reserveTokens;

  const workingSegments = [...segments];
  let totalTokens = calculateTotalTokens(workingSegments);
  let removedSegments = 0;

  logger.info("Starting token truncation", {
    modelId: modelConfig.id,
    contextWindow,
    maxPromptTokens,
    initialTokens: totalTokens,
    initialSegments: segments.length
  });

  // If we're already within limits, no truncation needed
  if (totalTokens <= maxPromptTokens) {
    return {
      truncatedSegments: workingSegments,
      totalTokens,
      wasTruncated: false
    };
  }

  // Strategy 1: Remove memory segments (middle elements, oldest first)
  // Keep system prompt (index 0) and user prompt (last index)
  const mutableSegments = [...workingSegments];
  while (totalTokens > maxPromptTokens && mutableSegments.length > 2) {
    // Remove the first memory segment (index 1, which is the oldest)
    if (mutableSegments.length > 2) {
      mutableSegments.splice(1, 1);
      removedSegments++;
      totalTokens = calculateTotalTokens(mutableSegments);
      
      logger.debug("Removed memory segment", {
        remainingSegments: mutableSegments.length,
        currentTokens: totalTokens,
        removedCount: removedSegments
      });
    }
  }

  // Strategy 2: If still too large, truncate system prompt
  if (totalTokens > maxPromptTokens && mutableSegments.length >= 1) {
    const systemSegment = mutableSegments[0];
    const userSegment = mutableSegments[mutableSegments.length - 1];
    
    // Calculate how many tokens we need to save
    const userTokens = estimateTokens(userSegment.content);
    const availableForSystem = maxPromptTokens - userTokens - 50; // 50 token buffer
    
    if (availableForSystem > 100) { // Keep at least 100 tokens for system
      // Truncate system prompt to fit
      const maxSystemChars = Math.floor(availableForSystem * 4); // Rough conversion back to chars
      const truncatedSystemContent = systemSegment.content.substring(0, maxSystemChars) + 
        (systemSegment.content.length > maxSystemChars ? "..." : "");
      
      mutableSegments[0] = {
        role: "system",
        content: truncatedSystemContent
      };
      
      totalTokens = calculateTotalTokens(mutableSegments);
      
      logger.warn("Truncated system prompt", {
        originalLength: systemSegment.content.length,
        truncatedLength: truncatedSystemContent.length,
        finalTokens: totalTokens
      });
    }
  }

  const wasTruncated = removedSegments > 0 || totalTokens !== calculateTotalTokens(segments);

  logger.info("Token truncation completed", {
    modelId: modelConfig.id,
    wasTruncated,
    originalSegments: segments.length,
    finalSegments: mutableSegments.length,
    removedSegments,
    originalTokens: calculateTotalTokens(segments),
    finalTokens: totalTokens,
    contextWindow: maxPromptTokens
  });

  return {
    truncatedSegments: mutableSegments,
    totalTokens,
    wasTruncated,
    removedSegments
  };
}