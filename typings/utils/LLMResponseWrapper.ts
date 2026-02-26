/**
 * Public-repo stub — typings/utils/LLMResponseWrapper.ts
 *
 * In the full system this lives in a shared platform package.
 * Here we provide just enough surface for the runner to typecheck.
 */

export interface ResponseMetadata {
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  generationTimeMs: number;
  estimatedCostUSD?: number;
  modelSupportsJSON?: boolean;
  modelSupportsStreaming?: boolean;
  cacheHit?: boolean;
  truncationApplied?: boolean;
  error?: string;
  basePromptVersion?: string;
  promptVersionUsed?: string;
  promptSegmentBreakdown?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BaseLLMResponse<T = string> {
  success: boolean;
  output: T;
  model: string;
  stepId: string;
  promptVersionUsed?: string;
  outputSchemaVersion?: string;
  metadata: ResponseMetadata;
  warnings: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export declare class LLMResponseWrapper {
  static isSuccess(response: BaseLLMResponse<unknown>): boolean;
  static validateStructure(
    output: string,
    expectedFormat?: string
  ): ValidationResult;
  static createPartialResponse(
    stepId: string,
    model: string,
    partialOutput: string,
    chunkCount: number,
    awsRequestId?: string
  ): BaseLLMResponse<string>;
}

export declare function wrapSuccess(params: {
  stepId: string;
  model: string;
  output: string;
  tokensUsed: number;
  generationTimeMs: number;
  promptVersionUsed?: string;
  awsRequestId?: string;
  warnings?: string[];
  additionalMetadata?: Record<string, unknown>;
}): BaseLLMResponse<string>;

export declare function wrapError(
  stepId: string,
  model: string,
  error: string,
  generationTimeMs: number,
  awsRequestId?: string
): BaseLLMResponse<null>;
