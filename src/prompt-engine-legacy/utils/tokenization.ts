// amplify/functions/workflow-runner/src/prompt-engine/utils/tokenization.ts

import type { ModelCapability } from "../../modelCapabilities";
import type { TokenizationConfig } from "../types";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "PromptEngine.Tokenization" });

// Token estimation methods by model provider
const PROVIDER_CONFIGS: Record<string, { charsPerToken: number; overhead: number }> = {
  openai: { charsPerToken: 4, overhead: 12 }, // GPT models average ~4 chars/token
  anthropic: { charsPerToken: 3.5, overhead: 15 }, // Claude models slightly more efficient
  amazon: { charsPerToken: 4.2, overhead: 10 }, // Nova models similar to GPT
  meta: { charsPerToken: 3.8, overhead: 8 } // Llama models efficient encoding
};

/**
 * Create tokenization configuration for a model
 */
export function createTokenizationConfig(modelConfig: ModelCapability): TokenizationConfig {
  const providerConfig = PROVIDER_CONFIGS[modelConfig.provider] || PROVIDER_CONFIGS.openai;
  
  return {
    modelId: modelConfig.id,
    estimationMethod: 'model_specific',
    overheadTokens: providerConfig.overhead
  };
}

/**
 * Estimate token count for text content using model-specific approximation
 * This is more accurate than the crude chars/4 method but not perfect
 * Production systems should use actual tokenizers when available
 */
export function estimateTokens(content: string, config: TokenizationConfig): number {
  if (!content || content.length === 0) return 0;
  
  const providerConfig = getProviderConfig(config.modelId);
  
  // Base character estimation
  const baseTokens = Math.ceil(content.length / providerConfig.charsPerToken);
  
  // Add overhead for message formatting (role labels, etc.)
  const totalTokens = baseTokens + config.overheadTokens;
  
  logger.debug("Token estimation", {
    modelId: config.modelId,
    contentLength: content.length,
    charsPerToken: providerConfig.charsPerToken,
    baseTokens,
    overheadTokens: config.overheadTokens,
    totalTokens
  });
  
  return totalTokens;
}

/**
 * Estimate tokens for multiple content segments
 */
export function estimateTokensForSegments(
  segments: Array<{ content: string }>, 
  config: TokenizationConfig
): number {
  return segments.reduce((total, segment) => {
    return total + estimateTokens(segment.content, config);
  }, 0);
}

/**
 * Calculate context window utilization percentage
 */
export function calculateUtilization(
  estimatedTokens: number, 
  contextWindow: number
): number {
  if (contextWindow <= 0) return 0;
  return Math.round((estimatedTokens / contextWindow) * 100);
}

/**
 * Check if content would exceed context window with safety buffer
 */
export function wouldExceedContext(
  estimatedTokens: number, 
  contextWindow: number, 
  bufferPercent: number = 10
): boolean {
  const maxAllowedTokens = Math.floor(contextWindow * (1 - bufferPercent / 100));
  return estimatedTokens > maxAllowedTokens;
}

/**
 * Calculate maximum tokens available for new content
 */
export function getAvailableTokens(
  currentTokens: number, 
  contextWindow: number, 
  bufferPercent: number = 10
): number {
  const maxAllowedTokens = Math.floor(contextWindow * (1 - bufferPercent / 100));
  return Math.max(0, maxAllowedTokens - currentTokens);
}

/**
 * Estimate character count for a target token count (reverse estimation)
 */
export function estimateCharsForTokens(
  targetTokens: number, 
  config: TokenizationConfig
): number {
  const providerConfig = getProviderConfig(config.modelId);
  const adjustedTokens = Math.max(0, targetTokens - config.overheadTokens);
  return Math.floor(adjustedTokens * providerConfig.charsPerToken);
}

/**
 * Get provider-specific configuration
 */
function getProviderConfig(modelId: string): { charsPerToken: number; overhead: number } {
  // Determine provider from model ID patterns
  if (modelId.includes('gpt') || modelId.includes('openai')) {
    return PROVIDER_CONFIGS.openai;
  } else if (modelId.includes('claude') || modelId.includes('anthropic')) {
    return PROVIDER_CONFIGS.anthropic;
  } else if (modelId.includes('nova') || modelId.includes('amazon')) {
    return PROVIDER_CONFIGS.amazon;
  } else if (modelId.includes('llama') || modelId.includes('meta')) {
    return PROVIDER_CONFIGS.meta;
  }
  
  // Default to OpenAI config
  logger.warn("Unknown model provider, using OpenAI defaults", { modelId });
  return PROVIDER_CONFIGS.openai;
}

/**
 * Advanced token estimation with content analysis
 * Accounts for repetitive patterns, whitespace, and special tokens
 */
export function advancedTokenEstimate(
  content: string, 
  config: TokenizationConfig
): { tokens: number; confidence: 'low' | 'medium' | 'high' } {
  if (!content || content.length === 0) {
    return { tokens: 0, confidence: 'high' };
  }
  
  const providerConfig = getProviderConfig(config.modelId);
  let adjustmentFactor = 1.0;
  let confidence: 'low' | 'medium' | 'high' = 'medium';
  
  // Analyze content characteristics
  const whitespaceRatio = (content.match(/\s/g) || []).length / content.length;
  const repetitionScore = calculateRepetitionScore(content);
  const specialCharCount = (content.match(/[^\w\s]/g) || []).length;
  
  // Adjust for high whitespace content (tokenizes more efficiently)
  if (whitespaceRatio > 0.3) {
    adjustmentFactor *= 0.9;
    confidence = 'medium';
  }
  
  // Adjust for repetitive content (may tokenize less efficiently)
  if (repetitionScore > 0.7) {
    adjustmentFactor *= 1.1;
    confidence = 'low';
  }
  
  // Adjust for special characters (may require more tokens)
  if (specialCharCount > content.length * 0.1) {
    adjustmentFactor *= 1.05;
  }
  
  // Base calculation with adjustments
  const baseTokens = Math.ceil(content.length / providerConfig.charsPerToken);
  const adjustedTokens = Math.ceil(baseTokens * adjustmentFactor);
  const totalTokens = adjustedTokens + config.overheadTokens;
  
  logger.debug("Advanced token estimation", {
    modelId: config.modelId,
    contentLength: content.length,
    whitespaceRatio,
    repetitionScore,
    specialCharCount,
    adjustmentFactor,
    baseTokens,
    adjustedTokens,
    totalTokens,
    confidence
  });
  
  return { tokens: totalTokens, confidence };
}

/**
 * Calculate repetition score for content (0-1, higher = more repetitive)
 */
function calculateRepetitionScore(content: string): number {
  if (content.length < 10) return 0;
  
  const words = content.toLowerCase().split(/\s+/);
  const uniqueWords = new Set(words);
  
  return 1 - (uniqueWords.size / words.length);
}