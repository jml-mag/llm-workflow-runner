// amplify/functions/workflow-runner/src/nodes/ModelInvoke.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { State } from "../types";
import type { Schema } from "@platform/data/resource";
import { EnhancedLLMService } from "../llm/enhancedLLMService";
import { LLMResponseWrapper } from "@platform/utils/LLMResponseWrapper";
import { logProgressForOwners } from "../utils/progress";
import type { DataClientWithProgress } from "../utils/progress";
import { safePutAnnotation } from "@platform/utils/tracing";
import { buildPromptWithNewEngine } from "../utils/PromptEngineAdapter";
import { getModelById } from "../modelCapabilities";
import { generateClient } from "aws-amplify/data";

const logger = new Logger({ serviceName: "EnhancedModelInvoke" });
const tracer = new Tracer({ serviceName: "EnhancedModelInvoke" });
const metrics = new Metrics({ serviceName: "EnhancedModelInvoke" });

const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID ?? "us.anthropic.claude-3-7-sonnet-20250219-v1:0";

export type OutputFormat = "json" | "text" | "markdown";
type DataClient = ReturnType<typeof generateClient<Schema>>;

// ============================================================================
// STREAMING HELPER FOR SSE HANDLER
// ============================================================================

export interface RunModelStreamOptions {
  workflowId: string;
  prompt: string;
  conversationId: string;
  client?: DataClientWithProgress | null;
  ownersForProgress?: ReadonlyArray<string>;
  persistProgress?: boolean;
  signal?: AbortSignal;
  onStart?: (meta: Record<string, unknown>) => void;
  onToken?: (t: string) => void;
  onMessage?: (text: string) => void;
  onEnd?: (final: Record<string, unknown>) => void;
  onError?: (err: Error | string) => void;
}

/**
 * Stream tokens using the existing EnhancedLLMService/executeLLMCall path.
 * Does NOT change builder/authed flows; unauth SSE will set persistProgress=false and omit owners/client.
 */
/**
 * Stream tokens directly from model for SSE use case.
 * Bypasses EnhancedLLMService since it doesn't support callback-based streaming.
 */
export async function runModelStream(opts: RunModelStreamOptions): Promise<void> {
  const {
    workflowId, prompt, conversationId,
    signal, onStart, onToken, onEnd, onError
  } = opts;

  onStart?.({ workflowId, conversationId });

  try {
    const modelId = process.env.DEFAULT_MODEL_ID || 'us.anthropic.claude-3-7-sonnet-20250219-v1:0';
    
    // Import model client directly
    const { createModelClient } = await import('../services/modelSelector');
    const llmClient = await createModelClient(modelId, {
      temperature: 0.7,
      maxTokens: 2000,
      region: process.env.AWS_REGION || 'us-east-1',
      streaming: true,
    }) as { stream?: (messages: Array<[string, string]>) => Promise<AsyncIterable<{ content?: string }>> };

    if (!llmClient?.stream) {
      throw new Error('Model client does not support streaming');
    }

    // Simple message format
    const messages: Array<[string, string]> = [
      ['human', prompt]
    ];

    const stream = await llmClient.stream(messages);
    let full = '';

    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new Error('aborted');
      }

      const text = chunk?.content || '';
      if (text) {
        full += text;
        onToken?.(text);
      }
    }

    onEnd?.({ status: 'ok', message: full });
  } catch (err) {
    if ((err as Error)?.message === 'aborted') {
      onError?.(err as Error);
      return;
    }
    onError?.(err as Error);
    throw err;
  }
}

// ============================================================================
// ORIGINAL ENHANCED MODEL INVOKE
// ============================================================================

/**
 * Enhanced ModelInvoke node with S3 prompt archiving.
 * Always uses the new prompt engine with mandatory prompt archiving.
 * Respects configured model ID from workflow definition.
 */
export const handleEnhancedModelInvoke = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient,
  awsRequestId?: string
): Promise<Partial<State>> => {
  safePutAnnotation(tracer, "Node", "EnhancedModelInvoke");
  safePutAnnotation(tracer, "ConversationId", state.conversationId);
  safePutAnnotation(tracer, "PromptEngineMode", "NEW");

  logger.info("Enhanced ModelInvoke starting", {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    nodeId: state.currentNodeId,
    nodeType: state.currentNodeType,
    promptEngineMode: "NEW",
  });

  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);

  // Extract configuration early for skip check
  const config = state.currentNodeConfig ?? {};
  
  // ✅ GUARD: Skip intro ModelInvoke on reply-driven runs
  interface StateWithContext extends State {
    context?: { userPrompt?: string };
    messages?: Array<{ role: string }>;
  }
  const stateWithContext = state as StateWithContext;
  
  const hasUserReply =
    Boolean(state?.userPrompt) ||
    Boolean(stateWithContext.context?.userPrompt) ||
    (Array.isArray(stateWithContext.messages) && stateWithContext.messages.some(m => m?.role === "user"));

  /**
   * Optional guard (enable per workflow JSON on nodes like the CFO "intro"):
   * {
   *   "type": "ModelInvoke",
   *   "config": { "skipIfUserPrompt": true, ... }
   * }
   */
  interface ConfigWithSkip extends Record<string, unknown> {
    skipIfUserPrompt?: boolean;
  }
  const configWithSkip = config as ConfigWithSkip;
  
  if (configWithSkip.skipIfUserPrompt && hasUserReply) {
    logger.info(`ModelInvoke(${state.currentNodeId}): skipIfUserPrompt=true and userPrompt present; skipping LLM call.`);
    
    // Emit a quick STREAMING status to keep UI phase mapping happy
    try {
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "ModelInvoke",
        status: "STREAMING",
        message: "Continuing workflow…",
        metadata: JSON.stringify({ 
          skipped: true,
          reason: "skipIfUserPrompt",
          nodeId: state.currentNodeId
        })
      });
    } catch {}
    
    return { }; // no memory writes, just proceed to next edge
  }

  // Generate unique request ID for tracking streaming events
  const requestId = `${state.workflowId}-${state.conversationId}-${Date.now()}`;

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "ModelInvoke",
    status: "STARTED",
    message: "Generating answer…",
    metadata: JSON.stringify({
      requestId,
      userVisible: true,
      ui: { 
        kind: "status", 
        title: "Generate", 
        body: "Model started…" 
      },
      nodeId: state.currentNodeId,
      architecture: "versioned_prompt_engine_v1",
      promptEngineEnabled: true,
      features: [
        "centralized_prompt_building",
        "structured_output_schema",
        "model_capability_detection",
        "streaming_support",
        "comprehensive_observability",
        "versioned_prompts",
        "atomic_rollouts",
        "cas_updates",
        "circuit_breaker_integration",
        "s3_prompt_archiving"
      ],
    }),
  });

  try {
    // Extract configuration
    const stepPrompt: string =
      config.systemPrompt ?? "Process the user input according to your capabilities.";
    const outputFormat = (config.outputFormat ?? "text") as OutputFormat;
    const useMemory: boolean = config.useMemory ?? true;

    // Resolve model ID with fallback chain
    const modelId: string = config.modelId ?? DEFAULT_MODEL_ID;
    const modelConfig = getModelById(modelId);

    logger.info("Node configuration extracted", {
      hasStepPrompt: stepPrompt.length > 0,
      outputFormat,
      useMemory,
      modelId: modelConfig.id,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      promptEngineMode: "NEW",
    });

    // ===== NEW PROMPT ENGINE PATH (always) =====
    const { messages, metadata } = await buildPromptWithNewEngine(state, modelConfig, {
      outputFormat,
      stepPrompt,
    });

    logger.info("Prompt engine build completed", {
      basePromptVersion: metadata.basePromptVersion,
      tokens: metadata.totalTokens,
      buildTimeMs: metadata.buildTimeMs,
      costEstimate: metadata.costEstimate,
      piiDetected: metadata.piiDetected,
      modelId: modelConfig.id,
    });

    safePutAnnotation(tracer, "BasePromptVersion", metadata.basePromptVersion);
    safePutAnnotation(tracer, "PromptTokens", String(metadata.totalTokens));

    // 3. Do the work - execute LLM call
    // Note: Streaming progress events are handled internally by EnhancedLLMService
    // which already emits STREAMING status updates via logProgressForOwners
    const executionResult = await EnhancedLLMService.executeLLMCall({
      state,
      dataClient,
      messages, // pre-built messages from new engine
      outputFormat,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      streaming: config.streaming,
      awsRequestId,
    });

    metrics.addMetric("NewPromptEngineUsage", MetricUnit.Count, 1);
    metrics.addMetric("PromptBuildTime", MetricUnit.Milliseconds, metadata.buildTimeMs);

    if (!executionResult.success) {
      logger.error("Enhanced LLM execution failed", {
        stepId: state.currentNodeId,
        error: executionResult.response.metadata.error,
        promptEngineMode: "NEW",
      });
      throw new Error(`LLM execution failed: ${executionResult.response.metadata.error}`);
    }

    // ===== ARCHIVE PROMPT TO S3 AFTER SUCCESSFUL EXECUTION =====
    try {
      const { archivePromptToS3, toLines } = await import("../utils/promptArchiver");
      await archivePromptToS3({
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        modelId,
        stepId: state.currentNodeId,
        pointerId: null,
        basePromptVersionId: metadata.basePromptVersion,
        totalTokens: metadata.totalTokens,
        wasTruncated: false,
        createdAtIso: new Date().toISOString(),
        lines: toLines(messages, 8, 1500)
      });
      
      logger.info("Prompt archived successfully", { 
        stepId: state.currentNodeId,
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        archiveTokens: metadata.totalTokens,
        basePromptVersion: metadata.basePromptVersion
      });

      metrics.addMetric("PromptsArchived", MetricUnit.Count, 1);
      metrics.addMetric("ArchivedPromptTokens", MetricUnit.Count, metadata.totalTokens);
    } catch (archiveError) {
      logger.warn("Prompt archiving failed (non-fatal)", {
        error: archiveError instanceof Error ? archiveError.message : "Unknown error",
        stepId: state.currentNodeId,
        workflowId: state.workflowId
      });
      
      metrics.addMetric("PromptArchiveFailures", MetricUnit.Count, 1);
      // Continue execution - archiving failure should not block workflow
    }

    // ===== EXTRACT RESULTS =====
    const { response: wrappedResponse, formattedOutput, rawOutput } = executionResult;
    const responseMetadata = wrappedResponse.metadata;

    // ===== SAVE MEMORY IF ENABLED =====
    if (useMemory) {
      try {
        if (state.userPrompt?.trim().length) {
          await dataClient.models.Memory.create({
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            role: "user",
            content: state.userPrompt,
            timestamp: new Date().toISOString(),
          });
        }
        if (formattedOutput?.trim().length) {
          const outputToSave =
            formattedOutput.length > 50000
              ? `${formattedOutput.substring(0, 50000)}... [truncated]`
              : formattedOutput;
          await dataClient.models.Memory.create({
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            role: "assistant",
            content: outputToSave,
            timestamp: new Date().toISOString(),
          });
        }
        metrics.addMetric("MemoryWrites", MetricUnit.Count, 2);
      } catch (memoryError) {
        logger.warn("Failed to save memory", {
          error: memoryError instanceof Error ? memoryError.message : "Unknown error",
        });
      }
    }

    // 4. Emit COMPLETED with the full response text
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "ModelInvoke",
      status: "COMPLETED",
      message: formattedOutput,
      metadata: JSON.stringify({
        requestId,
        finalResponse: { text: formattedOutput },
        totalTokens: responseMetadata.tokensUsed,
        durationMs: responseMetadata.generationTimeMs,
        // Structured metadata for telemetry
        promptEngineMode: "NEW",
        promptVersionUsed: wrappedResponse.promptVersionUsed,
        basePromptVersion: wrappedResponse.metadata?.basePromptVersion,
        outputSchemaVersion: wrappedResponse.outputSchemaVersion,
        baseSystemPromptIncluded: true,
        promptArchived: true,
        modelId: wrappedResponse.model,
        tokensUsed: responseMetadata.tokensUsed,
        inputTokens: responseMetadata.inputTokens,
        outputTokens: responseMetadata.outputTokens,
        generationTimeMs: responseMetadata.generationTimeMs,
        estimatedCostUSD: responseMetadata.estimatedCostUSD,
        modelSupportsJSON: responseMetadata.modelSupportsJSON ?? false,
        modelSupportsStreaming: responseMetadata.modelSupportsStreaming ?? false,
        streamingUsed: Boolean((config as { streaming?: boolean }).streaming),
        cacheHit: responseMetadata.cacheHit,
        truncationApplied: responseMetadata.truncationApplied,
        hasWarnings: wrappedResponse.warnings.length > 0,
        warnings: wrappedResponse.warnings,
        outputFormat,
        validationPassed: LLMResponseWrapper.isSuccess(wrappedResponse),
        awsRequestId,
        executionTimestamp: new Date().toISOString(),
        nodeId: state.currentNodeId,
        nodeType: state.currentNodeType,
        promptSegmentBreakdown: responseMetadata.promptSegmentBreakdown ?? {},
        memoryEnabled: useMemory,
        memoryEntriesSaved: useMemory ? 2 : 0,
      }),
    });

    // ===== RECORD SUCCESS METRICS =====
    metrics.addMetric("EnhancedModelInvocations", MetricUnit.Count, 1);
    metrics.addMetric(
      "EnhancedModelTokensUsed",
      MetricUnit.Count,
      responseMetadata.tokensUsed ?? 0
    );
    metrics.addMetric(
      "EnhancedModelExecutionTime",
      MetricUnit.Milliseconds,
      responseMetadata.generationTimeMs
    );

    if (typeof responseMetadata.estimatedCostUSD === "number") {
      metrics.addMetric(
        "EnhancedModelCostMicroUSD",
        MetricUnit.Count,
        Math.round(responseMetadata.estimatedCostUSD * 1_000_000)
      );
    }

    const finalPromptVersion =
      wrappedResponse.promptVersionUsed ??
      wrappedResponse.metadata?.promptVersionUsed ??
      "unknown";

    logger.info("Enhanced ModelInvoke completed successfully", {
      stepId: state.currentNodeId,
      modelId: wrappedResponse.model,
      tokensUsed: responseMetadata.tokensUsed,
      executionTimeMs: responseMetadata.generationTimeMs,
      outputLength: formattedOutput.length,
      promptVersionUsed: finalPromptVersion,
      promptEngineMode: "NEW",
      promptArchived: true,
      hasWarnings: wrappedResponse.warnings.length > 0,
    });

    return {
      modelResponse: rawOutput,
      formattedResponse: formattedOutput,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error("Enhanced ModelInvoke failed", {
      error: errorMessage,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      nodeId: state.currentNodeId,
      promptEngineMode: "NEW",
    });

    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "ModelInvoke",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        architecture: "versioned_prompt_engine_v1",
        promptEngineMode: "NEW",
        nodeId: state.currentNodeId,
        nodeType: state.currentNodeType,
        awsRequestId,
        failureTimestamp: new Date().toISOString(),
      }),
    });

    metrics.addMetric("EnhancedModelInvokeErrors", MetricUnit.Count, 1);
    throw error;
  }
};

export const handleModelInvoke = handleEnhancedModelInvoke;
export default handleEnhancedModelInvoke;