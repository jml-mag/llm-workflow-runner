// amplify/functions/workflow-runner/src/llm/enhancedLLMService.ts
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { createHash } from 'crypto';
import { createModelClient } from '../services/modelSelector';
import { getModelById } from '../modelCapabilities';
import PromptBuilder, { createPromptOptionsFromState } from '../utils/PromptBuilder';
import { LLMResponseWrapper, wrapSuccess, wrapError } from "@platform/utils/LLMResponseWrapper";
import { archivePromptToS3, toLines } from "../utils/promptArchiver";
import { logProgressForOwners } from '../utils/progress'; // Import shared helper
import type { BaseLLMResponse } from "@platform/utils/LLMResponseWrapper";
import type { State } from '../types';
import type { Schema } from "@platform/data/resource";

const logger = new Logger({ serviceName: 'EnhancedLLMService' });
const metrics = new Metrics({ serviceName: 'EnhancedLLMService' });

type DataClient = ReturnType<typeof import('aws-amplify/data').generateClient<Schema>>;

// Type for message content that can be string or structured
type MessageContent = string | Array<{ text?: string }>;

// Type for ChatBedrockConverse AIMessageChunk
type AIMessageChunk = { content: string };

// Strict, public message type used by callers that provide prebuilt messages
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string; // widen to MessageContent later if you adopt multimodal/parts
}

// Helper functions for diagnostics
function safePreview(s: unknown, limit = 200): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '', null, 2);
  return str.length > limit ? `${str.slice(0, limit)}… [${str.length} chars]` : str;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function estimateTokensFromMessages(msgs: ReadonlyArray<LLMMessage>): number {
  const chars = msgs.reduce((acc, m) => acc + m.content.length, 0);
  return Math.ceil(chars / 4); // simple estimator aligned with rest of codebase
}

function typeSig(x: unknown): { type: string; ctor: string; keys: string[]; hasAsyncIterator: boolean } {
  try {
    return {
      type: typeof x,
      ctor: (x as Record<string, unknown>)?.constructor?.name as string,
      keys: x && typeof x === 'object' ? Object.keys(x as object).slice(0, 20) : [],
      hasAsyncIterator: !!(x as Record<symbol, unknown>)?.[Symbol.asyncIterator],
    };
  } catch {
    return { type: typeof x, ctor: 'unknown', keys: [], hasAsyncIterator: false };
  }
}

function isAIMessageChunk(x: unknown): x is AIMessageChunk {
  return (
    !!x &&
    typeof x === 'object' &&
    'content' in (x as Record<string, unknown>) &&
    typeof (x as { content?: unknown }).content === 'string'
  );
}

function isAsyncIterable<T = unknown>(obj: unknown): obj is AsyncIterable<T> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

// Interface for LLM execution options
export interface LLMExecutionOptions {
  state: State;
  dataClient: DataClient;
  stepPrompt?: string;
  outputFormat?: 'json' | 'text' | 'markdown';
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  awsRequestId?: string;
  /** When provided, skip internal prompt building and use these messages */
  messages?: ReadonlyArray<LLMMessage>;
}

// Result interface for LLM execution
export interface LLMExecutionResult {
  success: boolean;
  response: BaseLLMResponse<string> | BaseLLMResponse<null>;
  rawOutput: string;
  formattedOutput: string;
  executionTimeMs: number;
}

// Type for LLM client with proper typing
interface LLMClient {
  invoke?: (messages: unknown) => Promise<unknown>;
  stream?: (messages: unknown) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
}

// Internal shapes to avoid `any`
type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: MessageContent };

interface PromptResultShape {
  messages: Array<PromptMessage>;
  metadata: {
    promptVersionUsed: string;
    totalTokensEstimate: number;
    supportsJSONMode: boolean;
    supportsStreaming: boolean;
    segmentBreakdown?: Record<string, unknown>;
  };
}

/**
 * Get the appropriate API model ID based on model registry configuration
 * Respects workflow-configured model IDs without hardcoding enforcement
 */
function getApiModelId(modelId: string): string {
  const model = getModelById(modelId);
  if (!model) {
    logger.warn("Model not found in registry, using modelId as-is", {
      requestedModelId: modelId
    });
    return modelId;
  }
  
  const bedrockMap = (model as { apiModelIds?: { bedrock?: Record<string, string> } }).apiModelIds?.bedrock;
  if (bedrockMap && typeof bedrockMap === "object") {
    const inferenceType = (model as { defaultInferenceType?: string }).defaultInferenceType ?? "serverless";
    const mapped = bedrockMap[inferenceType];
    if (typeof mapped === "string" && mapped.length > 0) {
      logger.info("Using configured API model ID from registry", {
        originalModelId: modelId, 
        apiModelId: mapped, 
        inferenceType,
        provider: (model as { provider?: string }).provider,
      });
      return mapped;
    }
  }
  
  const fallback = (model as { apiModelIds?: { default?: string } }).apiModelIds?.default;
  if (typeof fallback === "string" && fallback.length > 0) {
    logger.debug("Using default API model ID", {
      originalModelId: modelId, 
      apiModelId: fallback,
      provider: (model as { provider?: string }).provider,
    });
    return fallback;
  }
  
  logger.debug("No mapping found; using modelId as-is", {
    originalModelId: modelId,
    provider: (model as { provider?: string }).provider,
  });
  return modelId;
}

/**
 * Adapter wrapper for clean ModelInvoke integration
 * Maps to the existing EnhancedLLMService.executeLLMCall method
 */
export async function invokeLLMAdapter(args: {
  modelId: string;
  messages: ReadonlyArray<LLMMessage>;
  stream: boolean;
  state: State;
  dataClient: DataClient;
  temperature?: number;
  maxTokens?: number;
  outputFormat?: 'json' | 'text' | 'markdown';
  awsRequestId?: string;
}) {
  // Call your actual service (existing method, unchanged)
  const result = await EnhancedLLMService.executeLLMCall({
    state: args.state,
    dataClient: args.dataClient,
    messages: args.messages,
    outputFormat: args.outputFormat,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    streaming: args.stream,
    awsRequestId: args.awsRequestId,
  });

  // Create a simple text stream from the result
  async function* createTextStream() {
    if (result.success) {
      yield result.formattedOutput;
    }
  }

  // Normalize result shape for ModelInvoke consumption
  return {
    textStream: createTextStream(),
    tokensIn: result.response.metadata?.inputTokens ?? null,
    tokensOut: result.response.metadata?.outputTokens ?? null,
    costUsd: result.response.metadata?.estimatedCostUSD ?? null,
    modelId: args.modelId,
    raw: result // keep the full original for existing logic that inspects it
  };
}

/**
 * Enhanced LLM Service with centralized prompt architecture + optional pre-built messages
 */
export class EnhancedLLMService {
  /**
   * Execute LLM call with full prompt builder integration or pre-built messages
   * Respects workflow-configured model IDs without enforcement
   */
  static async executeLLMCall(options: LLMExecutionOptions): Promise<LLMExecutionResult> {
    const startTime = Date.now();
    const { state, dataClient, awsRequestId, messages } = options;

    // Get deduplicated owners for progress tracking
    const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId]));

    // Pin common context on every log
    logger.appendKeys({
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepId: state.currentNodeId,
      userId: state.userId,
      awsRequestId,
      awsRegion: process.env.AWS_REGION,
      nodejs: process.versions?.node,
    });

    // Extract configuration with proper model ID resolution
    const config = state.currentNodeConfig || {};
    const stepId = state.currentNodeId || 'unknown';
    const rawModelId = config.modelId || process.env.DEFAULT_MODEL_ID || 'us.anthropic.claude-3-7-sonnet-20250219-v1:0';

    // Map to API model ID (respects registry configuration)
    const modelId = getApiModelId(rawModelId);

    logger.info('Starting enhanced LLM execution', {
      stepId,
      originalModelId: rawModelId,
      mappedModelId: modelId,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      awsRequestId,
      usingPreBuiltMessages: !!(messages && messages.length > 0),
    });

    try {
      // ===== STEP 1: Get Model Configuration =====
      const model = getModelById(rawModelId);
      if (!model) {
        throw new Error(`Model not found in registry: ${rawModelId}`);
      }

      // Probe capabilities in a typed-safe way
      type ModelCapsProbe = Partial<{
        supportsJSON: boolean;
        supportsStreaming: boolean;
        capabilities: string[];
      }>;
      const modelCaps = model as ModelCapsProbe;
      const supportsJSON =
        modelCaps.supportsJSON === true ||
        (Array.isArray(modelCaps.capabilities) && modelCaps.capabilities.includes('json')) ||
        false;
      const supportsStreamingDefault =
        modelCaps.supportsStreaming === true ||
        (Array.isArray(modelCaps.capabilities) && modelCaps.capabilities.includes('streaming')) ||
        true;

      // ===== STEP 2: Build or Use Pre-built Messages =====
      let promptResult: PromptResultShape;
      let finalMessages: Array<PromptMessage>;

      if (messages && messages.length > 0) {
        // NEW: Use pre-built messages from prompt engine
        logger.info('Using pre-built messages from prompt engine', {
          messageCount: messages.length,
          stepId,
        });

        finalMessages = messages.map(
          (msg: LLMMessage): PromptMessage => ({
            role: msg.role,
            content: msg.content,
          })
        );

        promptResult = {
          messages: finalMessages,
          metadata: {
            promptVersionUsed: 'prompt-engine-v1',
            totalTokensEstimate: estimateTokensFromMessages(messages),
            supportsJSONMode: supportsJSON,
            supportsStreaming: supportsStreamingDefault,
            segmentBreakdown: { source: 'prompt-engine', count: messages.length },
          },
        };

        logger.info('Pre-built messages processed', {
          messageCount: finalMessages.length,
          estimatedTokens: promptResult.metadata.totalTokensEstimate,
          modelSupportsJSON: promptResult.metadata.supportsJSONMode,
          modelSupportsStreaming: promptResult.metadata.supportsStreaming,
        });
      } else {
        // LEGACY: Build prompt with PromptBuilder
        const promptOptions = createPromptOptionsFromState(state, options.stepPrompt);
        const built = await PromptBuilder.buildPrompt(promptOptions);

        promptResult = {
          messages: built.messages as Array<PromptMessage>,
          metadata: {
            promptVersionUsed: built.metadata.promptVersionUsed,
            totalTokensEstimate: built.metadata.totalTokensEstimate,
            supportsJSONMode: built.metadata.supportsJSONMode,
            supportsStreaming: built.metadata.supportsStreaming,
            segmentBreakdown: built.metadata.segmentBreakdown,
          },
        };
        finalMessages = promptResult.messages;

        // Log PromptBuilder inputs/outputs safely
        const firstMessage = promptResult.messages?.[0];
        logger.info('Prompt builder detail', {
          messagesCount: promptResult.messages.length,
          firstMsgRole: firstMessage ? firstMessage.role : 'no-messages',
          firstMsgPreview: firstMessage ? safePreview(firstMessage.content, 180) : 'no-content',
          promptHash: sha256(JSON.stringify(promptResult.messages).slice(0, 10_000)), // bounded hash
          messageStructure: (promptResult.messages as Array<PromptMessage>)
            .slice(0, 2)
            .map((msg: PromptMessage) => ({
              role: msg.role,
              contentType: typeof msg.content,
              contentPreview: safePreview(msg.content, 50),
            })),
        });

        logger.info('Prompt built successfully', {
          messageCount: promptResult.messages.length,
          promptVersion: promptResult.metadata.promptVersionUsed,
          estimatedTokens: promptResult.metadata.totalTokensEstimate,
          modelSupportsJSON: promptResult.metadata.supportsJSONMode,
          modelSupportsStreaming: promptResult.metadata.supportsStreaming,
        });
      }

      // ===== STEP 2.5: Ensure first message is user for Bedrock chat =====
      if (finalMessages.length === 0 || finalMessages[0].role !== 'user') {
        logger.info('Prepending synthetic user message to satisfy Bedrock user-first requirement', {
          stepId,
          originalFirstRole: finalMessages[0]?.role ?? 'none',
          messageCountBefore: finalMessages.length,
        });

        const syntheticUserMessage: PromptMessage = {
          role: 'user',
          content: 'Please respond according to the system instructions and conversation context above.',
        };

        const baseMessages = finalMessages;
        finalMessages = [syntheticUserMessage, ...baseMessages];

        const extraTokens =
          typeof syntheticUserMessage.content === 'string'
            ? Math.ceil(syntheticUserMessage.content.length / 4)
            : 0;

        promptResult = {
          ...promptResult,
          messages: finalMessages,
          metadata: {
            ...promptResult.metadata,
            totalTokensEstimate: promptResult.metadata.totalTokensEstimate + extraTokens,
            segmentBreakdown: {
              ...(promptResult.metadata.segmentBreakdown ?? {}),
              syntheticUserPrepended: true,
            },
          },
        };

        logger.info('Synthetic user message prepended', {
          messageCountAfter: finalMessages.length,
          extraTokens,
        });
      }

      // ===== STEP 3: Configure LLM Client =====
      const temperature = options.temperature ?? config.temperature ?? 0.7;
      const maxTokens = options.maxTokens ?? config.maxTokens ?? 1000;
      const useStreaming =
        options.streaming ??
        (promptResult.metadata.supportsStreaming &&
          (typeof config.streaming === 'boolean' ? config.streaming : true));

      const llmClient = (await createModelClient(modelId, {
        temperature,
        maxTokens,
        region: process.env.AWS_REGION || 'us-east-1',
        streaming: useStreaming,
      })) as LLMClient;

      // Verify the client contract right after createModelClient
      logger.info('LLM client interface', {
        client: typeSig(llmClient),
        hasInvoke: typeof llmClient?.invoke === 'function',
        hasStream: typeof llmClient?.stream === 'function',
      });

      // Extra guard rails with explicit failure codes in metrics
      if (useStreaming && typeof llmClient?.stream !== 'function') {
        metrics.addMetric('LLMClientMissingStream', MetricUnit.Count, 1);
        logger.warn('Streaming requested but client.stream is not a function');
      }
      if (typeof llmClient?.invoke !== 'function') {
        metrics.addMetric('LLMClientMissingInvoke', MetricUnit.Count, 1);
        logger.warn('Client.invoke is not a function');
      }

      logger.info('LLM client configured', {
        originalModelId: rawModelId,
        mappedModelId: modelId,
        temperature,
        maxTokens,
        streaming: useStreaming,
        supportsJSON: promptResult.metadata.supportsJSONMode,
      });

      // --- ARCHIVE FINAL PROMPT TO S3 (exact messages that will be sent) ---
      if (process.env.PROMPT_ARCHIVE === "1") {
        const maxLines = Number(process.env.PROMPT_ARCHIVE_MAX_LINES ?? "8");
        const maxChars = Number(process.env.PROMPT_ARCHIVE_MAX_CHARS ?? "1500");
        try {
          const meta = (promptResult as { metadata?: Record<string, unknown> })?.metadata ?? {};
          await archivePromptToS3({
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            modelId, // mapped ID you actually invoke
            stepId,
            pointerId: (meta["pointerId"] as string | null) ?? null,
            basePromptVersionId: (meta["promptVersionUsed"] as string | null) ?? null,
            totalTokens: (meta["totalTokensEstimate"] as number) ?? 0,
            wasTruncated: (meta["wasTruncated"] as boolean) ?? false,
            createdAtIso: new Date().toISOString(),
            lines: toLines(finalMessages as ReadonlyArray<unknown>, maxLines, maxChars),
          });
        } catch (archiveErr) {
          logger.warn("Prompt archive failed (non-fatal)", {
            error: archiveErr instanceof Error ? archiveErr.message : "Unknown error",
          });
        }
      }
      // Use finalMessages -> tuples for ChatBedrockConverse
      const tupleMessages: Array<[string, string]> =
        this.convertMessagesToTuples(finalMessages);

      // Add explicit "tuple messages" sanity snapshot
      logger.debug('Tuple messages snapshot', {
        count: tupleMessages.length,
        head: tupleMessages.slice(0, 2).map(([r, c]) => ({ r, c: safePreview(c, 160) })),
      });

      // Record workflow progress for each owner (dual-write) with eventTime
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: 'ModelInvoke',
        status: 'STARTED',
        message: '',
        metadata: JSON.stringify({
          originalModelId: rawModelId,
          mappedModelId: modelId,
          timestamp: new Date().toISOString(),
        }),
        eventTime: new Date().toISOString(), // Explicitly set eventTime
      });

      // ===== STEP 4: Execute Model Call =====
      let rawOutput = '';
      let tokenCount = 0;
      let tRequestSent = 0;
      let firstChunkLatencyMs: number | undefined = undefined;

      if (useStreaming) {
        try {
          tRequestSent = Date.now();
          const streamResult = await this.executeStreamingCall(
            llmClient,
            tupleMessages,
            stepId,
            modelId,
            dataClient,
            state,
            owners,
            awsRequestId
          );
          rawOutput = streamResult.fullResponse;
          tokenCount = streamResult.tokenCount;

          if (streamResult.firstChunkReceivedAt && tRequestSent) {
            firstChunkLatencyMs = Math.max(0, streamResult.firstChunkReceivedAt - tRequestSent);
          }
        } catch (streamError) {
          logger.warn('Streaming failed, falling back to non-streaming', {
            error: streamError instanceof Error ? streamError.message : 'Unknown streaming error',
          });

          // Fallback to non-streaming with improved logging
          logger.debug('Invoking non-streaming LLM', { tupleCount: tupleMessages.length });
          let response: unknown;
          if (llmClient && typeof llmClient.invoke === 'function') {
            response = await llmClient.invoke(tupleMessages);
          } else {
            throw new Error('LLM client does not support invoke method');
          }

          logger.debug('Invoke response shape', {
            respSig: typeSig(response),
            respPreview: safePreview(response, 200),
          });

          if (response && typeof response === 'object' && 'content' in (response as Record<string, unknown>)) {
            const responseObj = response as { content: string };
            rawOutput = responseObj.content || '';
          } else {
            rawOutput = String(response ?? '');
          }
          tokenCount = Math.ceil(rawOutput.length / 4);
        }
      } else {
        logger.debug('Invoking non-streaming LLM', { tupleCount: tupleMessages.length });
        let response: unknown;
        if (llmClient && typeof llmClient.invoke === 'function') {
          response = await llmClient.invoke(tupleMessages);
        } else {
          throw new Error('LLM client does not support invoke method');
        }

        logger.debug('Invoke response shape', {
          respSig: typeSig(response),
          respPreview: safePreview(response, 200),
        });

        if (response && typeof response === 'object' && 'content' in (response as Record<string, unknown>)) {
          const responseObj = response as { content: string };
          rawOutput = responseObj.content || '';
        } else {
          rawOutput = String(response ?? '');
        }
        tokenCount = Math.ceil(rawOutput.length / 4);
      }

      const executionTime = Date.now() - startTime;

      // ===== STEP 5: Format Output =====
      const formattedOutput = await this.formatOutput(
        rawOutput,
        options.outputFormat || 'text'
      );

      // ===== STEP 6: Validate and Wrap Response =====
      const validation = LLMResponseWrapper.validateStructure(
        formattedOutput,
        options.outputFormat
      );

      // Build final wrapped response with accurate token and prompt metadata BEFORE logging/persisting
      const wrappedResponse = wrapSuccess({
        stepId,
        model: rawModelId,
        output: formattedOutput,
        tokensUsed: tokenCount,
        generationTimeMs: executionTime,
        promptVersionUsed: promptResult.metadata.promptVersionUsed,
        awsRequestId,
        warnings: validation.warnings,
        additionalMetadata: {
          inputTokens: promptResult.metadata.totalTokensEstimate,
          outputTokens: tokenCount,
          cacheHit: false,
          truncationApplied: false,
          modelSupportsJSON: promptResult.metadata.supportsJSONMode,
          modelSupportsStreaming: promptResult.metadata.supportsStreaming,
          promptSegmentBreakdown: promptResult.metadata.segmentBreakdown,
          ...(firstChunkLatencyMs !== undefined && { firstChunkLatencyMs }),
        },
      });

      // ===== STEP 7: Record Metrics and Progress =====
      await this.recordExecutionMetrics(
        rawModelId,
        tokenCount,
        executionTime,
        promptResult.metadata.totalTokensEstimate
      );

      await this.recordWorkflowProgress(
        dataClient,
        state,
        owners,
        formattedOutput,
        {
          ...wrappedResponse.metadata,
          originalModelId: rawModelId,
          mappedModelId: modelId,
        },
        'COMPLETED'
      );

      logger.info('LLM execution completed successfully', {
        stepId,
        originalModelId: rawModelId,
        mappedModelId: modelId,
        executionTimeMs: executionTime,
        tokensUsed: tokenCount,
        outputLength: formattedOutput.length,
        hasWarnings: validation.warnings.length > 0,
        usedPreBuiltMessages: !!(messages && messages.length > 0),
      });

      return {
        success: true,
        response: wrappedResponse,
        rawOutput,
        formattedOutput,
        executionTimeMs: executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const err = error as Error;
      const errorMessage = err?.message ?? 'Unknown error';
      const errorStack = err?.stack;

      // Add explicit failure codes + stack to ERROR logs and WorkflowProgress metadata
      let failureCode: string = 'Unknown';
      if (/stream/i.test(errorMessage) || /_streamIterator/i.test(errorMessage)) failureCode = 'StreamingIteratorError';
      else if (/generatePrompt/i.test(errorMessage)) failureCode = 'LangChainGeneratePromptUndefined';
      else if (/invoke method/i.test(errorMessage)) failureCode = 'ClientMissingInvoke';
      else if (/non-iterable/i.test(errorMessage)) failureCode = 'StreamNotAsyncIterable';

      logger.error('LLM execution failed', {
        error: errorMessage,
        failureCode,
        originalModelId: rawModelId,
        mappedModelId: getApiModelId(rawModelId),
        stack: safePreview(errorStack, 2000),
      });

      metrics.addMetric('LLMExecutionErrors', MetricUnit.Count, 1);
      metrics.addMetric(`LLMFailure_${failureCode}`, MetricUnit.Count, 1);
      metrics.addDimension('Model', getApiModelId(rawModelId));
      metrics.addDimension('FailureCode', failureCode);

      // Record error progress with stack (truncated) for quick triage - dual-write for owners
      await this.recordWorkflowProgress(
        dataClient,
        state,
        owners,
        '',
        {
          error: errorMessage,
          failureCode,
          stack: safePreview(errorStack, 2000),
          originalModelId: rawModelId,
          mappedModelId: getApiModelId(rawModelId),
        },
        'ERROR'
      );

      const errorResponse = wrapError(stepId, rawModelId, errorMessage, executionTime, awsRequestId);

      return {
        success: false,
        response: errorResponse,
        rawOutput: '',
        formattedOutput: '',
        executionTimeMs: executionTime,
      };
    }
  }

  /**
   * Convert messages to ChatBedrockConverse tuple format
   */
  private static convertMessagesToTuples(messages: Array<PromptMessage>): Array<[string, string]> {
    return messages.map((msg: PromptMessage) => {
      // Convert role names for ChatBedrockConverse
      const role = msg.role === 'user' ? 'human' : msg.role;

      // Convert content to string
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .map((item: { text?: string }) => (typeof item?.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('');
      }

      return [role, content] as [string, string];
    });
  }

  /**
   * Execute streaming LLM call for ChatBedrockConverse with tuple messages
   */
  private static async executeStreamingCall(
    llmClient: LLMClient,
    tupleMessages: Array<[string, string]>,
    stepId: string,
    modelId: string,
    dataClient: DataClient,
    state: State,
    owners: string[],
    awsRequestId?: string
  ): Promise<{ fullResponse: string; tokenCount: number; firstChunkReceivedAt?: number }> {
    let fullResponse = '';
    let chunkCount = 0;
    let streamedTokens = 0;

    logger.info('Starting streaming execution', {
      stepId,
      modelId,
    });

    try {
      let stream: AsyncIterable<unknown>;
      if (llmClient && typeof llmClient.stream === 'function') {
        stream = await llmClient.stream(tupleMessages);
      } else {
        throw new Error('LLM client does not support streaming');
      }

      // Harden streaming diagnostics
      logger.debug('Stream object received', { sig: typeSig(stream) });
      if (!isAsyncIterable(stream)) {
        metrics.addMetric('LLMStreamNotAsyncIterable', MetricUnit.Count, 1);
        throw new Error('Model stream() returned a non-iterable result');
      }

      // track first-chunk latency (capture timestamp on first chunk)
      let firstChunkReceivedAt: number | undefined = undefined;
      for await (const chunk of stream) {
        chunkCount++;

        // Inside the for await loop, log unexpected chunk shapes
        if (!isAIMessageChunk(chunk)) {
          logger.warn('Non-AIMessageChunk shape', {
            chunkSig: typeSig(chunk),
            chunkPreview: safePreview(chunk, 200),
          });
        }

        let chunkText = '';
        if (isAIMessageChunk(chunk)) {
          chunkText = chunk.content || '';
        }

        if (chunkText && chunkText.trim()) {
          fullResponse += chunkText;
          const tokensInChunk = Math.ceil(chunkText.length / 4);
          streamedTokens += tokensInChunk;

          // record first-chunk latency when we see the first chunk
          if (firstChunkReceivedAt === undefined) {
            firstChunkReceivedAt = Date.now();
            // return first-chunk latency to caller via dataClient record (caller will derive tRequestSent)
            try {
              // Use shared helper for first chunk marker with eventTime
              await logProgressForOwners(dataClient, [state.userId], {
                workflowId: state.workflowId,
                conversationId: state.conversationId,
                stepName: 'ModelInvoke',
                status: 'STREAMING',
                message: '',
                metadata: JSON.stringify({ firstChunkReceivedAt }),
                eventTime: new Date().toISOString(),
              });
            } catch {
              /* best-effort */
            }
          }

          const partialResponse = LLMResponseWrapper.createPartialResponse(
            stepId,
            modelId,
            chunkText,
            chunkCount,
            awsRequestId
          );

          // annotate partial response with tokensUsed for accurate per-chunk accounting
          partialResponse.metadata = {
            ...(partialResponse.metadata as Record<string, unknown>),
            tokensUsed: tokensInChunk,
            generationTimeMs: 0, // placeholder for partial responses
          };

          // Write streaming progress for each owner (dual-write) using shared helper with eventTime
          await logProgressForOwners(dataClient, owners, {
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            stepName: 'ModelInvoke',
            status: 'STREAMING',
            message: chunkText,
            metadata: JSON.stringify({
              chunkNumber: chunkCount,
              isStreaming: true,
              partialResponse,
              tokensInChunk,
              timestamp: new Date().toISOString(),
            }),
            eventTime: new Date().toISOString(), // Explicitly set eventTime for each chunk
          });

          logger.debug('Streaming chunk processed', {
            chunkNumber: chunkCount,
            contentLength: chunkText.length,
            totalLength: fullResponse.length,
          });
        }
      }

      logger.info('Streaming execution completed', {
        stepId,
        modelId,
        totalChunks: chunkCount,
        finalLength: fullResponse.length,
        streamedTokens,
      });

      // Return with first chunk timing if available
      return {
        fullResponse,
        tokenCount: streamedTokens,
        ...(firstChunkReceivedAt && { firstChunkReceivedAt }),
      };
    } catch (error) {
      logger.error('Streaming execution failed', {
        stepId,
        modelId,
        error: error instanceof Error ? error.message : 'Unknown error',
        chunksProcessed: chunkCount,
        partialResponse: fullResponse.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Format output based on expected format
   */
  private static async formatOutput(
    rawOutput: string,
    expectedFormat: 'json' | 'text' | 'markdown'
  ): Promise<string> {
    switch (expectedFormat) {
      case 'json': {
        try {
          const parsed = JSON.parse(rawOutput);
          return JSON.stringify(parsed, null, 2);
        } catch {
          const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              return JSON.stringify(parsed, null, 2);
            } catch {
              return rawOutput;
            }
          }
          return rawOutput;
        }
      }
      case 'markdown':
        return rawOutput.replace(/^\s+|\s+$/g, '');
      case 'text':
      default:
        return rawOutput.trim();
    }
  }

  /**
   * Record execution metrics for observability
   */
  private static async recordExecutionMetrics(
    modelId: string,
    tokenCount: number,
    executionTimeMs: number,
    inputTokens: number
  ): Promise<void> {
    metrics.addMetric('LLMExecutions', MetricUnit.Count, 1);
    metrics.addMetric('LLMExecutionTime', MetricUnit.Milliseconds, executionTimeMs);
    metrics.addMetric('LLMTokensUsed', MetricUnit.Count, tokenCount);
    metrics.addMetric('LLMInputTokens', MetricUnit.Count, inputTokens);

    // Emit more granular success metrics
    metrics.addDimension('Model', modelId);
    metrics.addMetric(
      'LLMOutputsPerSecond',
      MetricUnit.Count,
      tokenCount / Math.max(executionTimeMs / 1000, 0.001)
    );
    metrics.addMetric(`LLMExecutions_${modelId.replace(/[^a-zA-Z0-9]/g, '_')}`, MetricUnit.Count, 1);

    logger.info('Execution metrics recorded', {
      modelId,
      tokenCount,
      executionTimeMs,
      inputTokens,
      tokensPerSecond: tokenCount / (executionTimeMs / 1000),
    });
  }

  /**
   * Record workflow progress with detailed metadata and owner-scoped access
   */
  private static async recordWorkflowProgress(
    dataClient: DataClient,
    state: State,
    owners: string[],
    output: string,
    metadata: Record<string, unknown>,
    status: 'COMPLETED' | 'ERROR'
  ): Promise<void> {
    try {
      const outputLen = typeof output === 'string' ? output.length : 0;

      // Use shared helper for progress logging with eventTime
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: 'ModelInvoke',
        status,
        // ⬇️ Minimal patch: do NOT include final content in message (prevents duplicate bubble)
        message:
          status === 'COMPLETED'
            ? ''
            : `Execution failed: ${String((metadata as Record<string, unknown>).error ?? '')}`,
        metadata: JSON.stringify({
          ...metadata,
          enhancedLLMService: true,
          baseSystemPromptUsed: true,
          structuredOutputApplied: true,
          // keep small preview for quick debugging, but only in metadata
          ...(status === 'COMPLETED' ? { outputPreview: safePreview(output, 200) } : {}),
          // include length always; include full output only if small enough
          outputLen,
          ...(status === 'COMPLETED' && outputLen <= 100_000 ? { fullOutput: output } : {}),
          timestamp: new Date().toISOString(),
        }),
        eventTime: new Date().toISOString(), // Explicitly set eventTime
      });
    } catch (error) {
      logger.error('Failed to record workflow progress', {
        error: error instanceof Error ? error.message : 'Unknown error',
        workflowId: state.workflowId,
      });
    }
  }
}

export default EnhancedLLMService;