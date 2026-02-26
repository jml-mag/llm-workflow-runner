// amplify/functions/workflow-runner/src/prompt-engine/types.ts

import type { BaseMessage } from "@langchain/core/messages";
import type { State } from "../types";
import type { ModelCapability } from "../modelCapabilities";
import type { Schema } from "../../../../data/resource";

// Core data client type
export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// Role types for prompt segments
export type PromptRole = "system" | "user" | "assistant";

// Core prompt segment structure
export interface PromptSegment {
  role: PromptRole;
  content: string;
}

// Memory segment from database
export interface MemorySegment {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

// Base prompt loaded from external storage
export interface BasePrompt {
  id: string;
  content: string;
  version: string;
  workflowId?: string;
  modelId: string;
  isActive: boolean;
}

// Cached prompt with TTL
export interface CachedPrompt {
  prompt: BasePrompt;
  cachedAt: number;
}

// Variable interpolation context
export interface InterpolationContext {
  workflowState: State;
  workflowId: string;
  conversationId: string;
  userId: string;
  nodeId: string;
  nodeType: string;
  slots: Record<string, string>;
  intent: string;
  timestamp: string;
  model: {
    id: string;
    provider: string;
    displayName: string;
  };
  // Add index signature for flexible property access
  [key: string]: unknown;
}

// Variable interpolation preview results
export interface InterpolationPreview {
  variablesFound: string[];
  variableValues: Record<string, unknown>;
  missingVariables: string[];
  hasAllVariables: boolean;
}

// Token truncation results
export interface TruncationResult {
  truncatedSegments: PromptSegment[];
  totalTokens: number;
  wasTruncated: boolean;
  removedSegments?: number;
  truncationDetails?: TruncationMetadata;
}

// Detailed truncation metadata for debugging
export interface TruncationMetadata {
  originalSegments: number;
  finalSegments: number;
  removedMemoryEntries: number;
  systemPromptTruncated: boolean;
  strategy: 'none' | 'memory_removal' | 'system_truncation';
}

// Main configuration for prompt engine
export interface PromptEngineConfig {
  workflowState: State;
  dataClient: DataClient;
  modelConfig: ModelCapability;
  stepPrompt?: string;
  useMemory?: boolean;
  memorySize?: number;
}

// Complete prompt engine result
export interface PromptEngineResult {
  messages: BaseMessage[];
  metadata: {
    totalTokens: number;
    contextUtilization: number;
    wasTruncated: boolean;
    basePromptVersion: string;
    memoryEntriesLoaded: number;
    segmentBreakdown: {
      system: number;
      memory: number;
      user: number;
    };
    truncationDetails?: TruncationMetadata;
    buildTimeMs: number;
    cacheHit: boolean;
  };
}

// Error types for structured error handling
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

// Token estimation configuration
export interface TokenizationConfig {
  modelId: string;
  estimationMethod: 'chars_per_4' | 'model_specific';
  overheadTokens: number; // Tokens reserved for message formatting
}

// Cache configuration
export interface CacheConfig {
  ttl: number;
  maxSize: number;
  enabled: boolean;
}