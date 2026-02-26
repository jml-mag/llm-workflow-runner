// amplify/functions/workflow-runner/src/prompt/types.ts

/**
 * Core types for the Prompt Engine
 */

export type Role = "system" | "user" | "assistant";

/**
 * Canonical prompt segment structure used internally
 */
export interface PromptSegment {
  role: Role;
  content: string;
}

/**
 * Structured error for prompt building failures
 */
export class PromptBuildError extends Error {
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PromptBuildError";
    this.details = details;
  }
}

/**
 * Result of token truncation operation
 */
export interface TruncationResult {
  truncatedSegments: PromptSegment[];
  totalTokens: number;
  wasTruncated: boolean;
  removedSegments?: number;
}

/**
 * Result of prompt building with metadata
 */
export interface PromptBuildResult {
  messages: import("@langchain/core/messages").BaseMessage[];
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
  };
}
export interface PromptFormatter {
  /**
   * Format prompt segments into LangChain BaseMessage array
   */
  formatMessages(segments: PromptSegment[]): import("@langchain/core/messages").BaseMessage[];
  
  /**
   * Handle any provider-specific prompt modifications
   */
  preprocessSegments?(segments: PromptSegment[]): PromptSegment[];
}