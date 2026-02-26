// amplify/functions/workflow-runner/src/utils/PromptEngineAdapter.ts
import type { Schema } from "@platform/data/resource";
import type { State } from "../types";
import type { ModelCapability } from "../modelCapabilities";
import { PromptEngine } from "../prompt-engine/core/index";
import { generateClient } from "aws-amplify/data";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { safePutAnnotation } from "@platform/utils/tracing";

const logger = new Logger({ serviceName: "PromptEngineAdapter" });
const tracer = new Tracer({ serviceName: "PromptEngineAdapter" });

export interface BuildPromptOptions {
  outputFormat?: "text" | "markdown" | "json";
  stepPrompt?: string;
}

export interface BuiltPrompt {
  messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
  metadata: {
    totalTokens: number;
    buildTimeMs: number;
    costEstimate: number;
    basePromptVersion: string;
    piiDetected?: boolean;
    promptSegmentBreakdown?: Record<string, unknown>;
  };
}

/**
 * Sanitizes tone/style input by removing control characters and limiting length
 */
function sanitizeStyleInput(input: string): string {
  return input.replace(/[^\w\s,\-_.]/g, "").slice(0, 120);
}

/**
 * Normalization strategy:
 * - If there are no non-system messages at all, inject a user seed (prefer userPrompt).
 * - If the first non-system turn is 'assistant' and there is no user turn yet,
 *   inject a minimal user seed (prefer userPrompt over "Continue.").
 */
function normalizeMessages(
  history: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
  userPrompt?: string
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  try {
    const sys = history.filter(m => m.role === "system");
    const nonSys = history.filter(m => m.role !== "system");
    
    // Case 1: No non-system messages at all → inject a user seed.
    if (nonSys.length === 0) {
      const seed = (userPrompt && userPrompt.trim().length > 0)
        ? userPrompt.trim()
        : "Please synthesize the collected inputs and proceed.";
      return [
        ...sys,
        { role: "user", content: seed }
      ];
    }
    
    const first = nonSys[0];
    const hasAnyUser = nonSys.some(m => m.role === "user");
    
    // Case 2: First non-system is assistant and no user exists
    if (first.role === "assistant" && !hasAnyUser) {
      logger.info("Normalizing messages: injecting synthetic user message to prevent assistant-first conversation");
      return [
        ...sys,
        { role: "user", content: (userPrompt?.trim() || "Continue.") },
        ...nonSys
      ];
    }
    
    return [...history];
  } catch {
    // On any unexpected shape, return history unchanged
    return [...history];
  }
}

/**
 * Builds prompts using the new prompt engine with proper fallback handling
 * Integrates with existing State structure and ModelCapability system
 * Now supports tone and style directives
 */
export async function buildPromptWithNewEngine(
  state: State,
  modelConfig: ModelCapability,
  opts: BuildPromptOptions = {}
): Promise<BuiltPrompt> {
  const startTime = Date.now();

  safePutAnnotation(tracer, "PromptEngineVersion", "v1");
  safePutAnnotation(tracer, "ModelId", modelConfig.id);

  logger.info("Starting new prompt engine build", {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    modelId: modelConfig.id,
    nodeId: state.currentNodeId
  });

  try {
    // Create data client instance
    const dataClient = generateClient<Schema>();

    // Initialize the new prompt engine
    const engine = new PromptEngine(dataClient);

    // === STYLE / TONE HANDLING ===
    const cfg = (state.currentNodeConfig ?? {}) as Record<string, unknown>;
    const rawStyle = typeof cfg["style"] === "string" ? cfg["style"].trim() : "";
    const rawTone = typeof cfg["tone"] === "string" ? cfg["tone"].trim() : "";

    // Basic validation (no control chars / overly long)
    const style = sanitizeStyleInput(rawStyle);
    const tone = sanitizeStyleInput(rawTone);

    const baseStep: string | undefined =
      (typeof cfg["systemPrompt"] === "string" && cfg["systemPrompt"]) ||
      ((cfg as { stepPrompt?: string }).stepPrompt && String((cfg as { stepPrompt?: string }).stepPrompt)) ||
      opts.stepPrompt;

    const parts: string[] = [];
    if (tone) parts.push(`tone: ${tone}`);
    if (style) parts.push(`style: ${style}`);

    const styleInstruction =
      parts.length > 0
        ? `You must respond using the following communication directives.\n- ${parts.join(
            "\n- "
          )}\n- Be clear, warm, concise, and professional; avoid pressure; invite follow-ups.`
        : "";

    let effectiveStepPrompt =
      styleInstruction && baseStep
        ? `${styleInstruction}\n\n${baseStep}`.trim()
        : styleInstruction || baseStep;

    // ✅ Interpolate {{input}} with the JSON payload carried in state.input
    if (effectiveStepPrompt?.includes("{{input}}")) {
      const inputJson = JSON.stringify(state.input ?? {}, null, 2);
      effectiveStepPrompt = effectiveStepPrompt.replace(/{{\s*input\s*}}/g, inputJson);
    }

    logger.info("[PromptEngineAdapter] Style/Tone applied", {
      tone,
      style,
      hasStyleInstruction: !!styleInstruction,
      effectiveStepPromptPreview: effectiveStepPrompt?.slice(0, 200)
    });

    // Build the prompt using the new engine
    const result = await engine.buildPrompt({
      workflowState: state,
      dataClient,
      modelConfig,
      tenantId: state.userId,
      useMemory: state.currentNodeConfig?.useMemory ?? true,
      memorySize: state.currentNodeConfig?.memorySize ?? 10,
      stepPrompt: effectiveStepPrompt,
      outputFormat:
        (state.currentNodeConfig?.outputFormat as "text" | "markdown" | "json" | undefined) ??
        opts.outputFormat ??
        "text",
    });

    const buildTimeMs = Date.now() - startTime;

    // Convert the engine's message format to the expected format
    let messages = result.messages.map((m) => {
      const messageType = m._getType();
      const role: "system" | "user" | "assistant" =
        messageType === "system" ? "system" :
          messageType === "human" ? "user" :
            "assistant";

      return {
        role,
        content: String(m.content)
      };
    });

    // ✅ Always append the current turn's userPrompt as a real user message (if present).
    // This guarantees a user-first turn for models that reject assistant-first conversations.
    if (state.userPrompt && state.userPrompt.trim().length > 0) {
      messages = [
        ...messages,
        { role: "user", content: state.userPrompt.trim() }
      ];
    }

    // ✅ NORMALIZE: Ensure conversation starts with a user message (defensive)
    messages = normalizeMessages(messages, state.userPrompt);

    // Debug: confirm roles after normalization
    const roleDistribution = messages.reduce((acc, m) => {
      acc[m.role] = (acc[m.role] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    logger.info("Prompt roles after normalization", { roleDistribution });

    // Handle optional promptSegmentBreakdown property safely
    const segment =
      (result.metadata as { promptSegmentBreakdown?: Record<string, unknown> } | undefined)
        ?.promptSegmentBreakdown ?? {};

    const builtPrompt: BuiltPrompt = {
      messages,
      metadata: {
        totalTokens: result.metadata.totalTokens,
        buildTimeMs: result.metadata.buildTimeMs || buildTimeMs,
        costEstimate: result.metadata.costEstimate,
        basePromptVersion: result.metadata.basePromptVersion,
        piiDetected: result.metadata.piiDetected === true,
        promptSegmentBreakdown: segment
      },
    };

    logger.info("New prompt engine build completed", {
      basePromptVersionId: result.metadata.basePromptVersion,
      totalTokens: result.metadata.totalTokens,
      buildTimeMs,
      messageCount: messages.length,
      piiDetected: result.metadata.piiDetected,
      modelId: modelConfig.id,
      appliedTone: tone || "(none)",
      appliedStyle: style || "(none)"
    });

    safePutAnnotation(tracer, "BasePromptVersion", result.metadata.basePromptVersion);
    safePutAnnotation(tracer, "PromptTokens", String(result.metadata.totalTokens));
    if (tone) safePutAnnotation(tracer, "AppliedTone", tone);
    if (style) safePutAnnotation(tracer, "AppliedStyle", style);

    return builtPrompt;

  } catch (error) {
    const buildTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error("New prompt engine build failed", {
      error: errorMessage,
      buildTimeMs,
      modelId: modelConfig.id,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      nodeId: state.currentNodeId,
      stack: error instanceof Error ? error.stack : undefined
    });

    safePutAnnotation(tracer, "PromptEngineError", errorMessage);

    throw new Error(`Prompt engine build failed: ${errorMessage}`);
  }
}

/**
 * Adapter wrapper for clean ModelInvoke integration
 * Maps to the existing buildPromptWithNewEngine function
 */
export async function buildPromptMessagesAdapter(args: {
  state: State;
  nodeProps: Record<string, unknown>;
  workflow: Record<string, unknown>;
}) {
  const { state } = args;

  // Resolve modelConfig (unchanged)
  const modelId =
    (args.nodeProps.modelId as string) ||
    process.env.DEFAULT_MODEL_ID ||
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0";
  const { getModelById } = await import("../modelCapabilities");
  const modelConfig = getModelById(modelId);

  // Pull node-level overrides if present
  const outputFormat =
    (state.currentNodeConfig?.outputFormat as "text" | "markdown" | "json" | undefined) ??
    "text";
  const stepPrompt =
    state.currentNodeConfig?.systemPrompt ??
    (state.currentNodeConfig as { stepPrompt?: string })?.stepPrompt;

  // Build with new engine (ensures outputFormat/stepPrompt are honored)
  const built = await buildPromptWithNewEngine(state, modelConfig, {
    outputFormat,
    stepPrompt,
  });

  // Normalize output to what ModelInvoke needs downstream
  const messages = built.messages;
  const metadata = {
    // Map fields that exist today
    basePromptVersionId: built.metadata.basePromptVersion,
    contentHash: null, // Not available in current implementation
    tokensIn: built.metadata.totalTokens,
    reservedOutputTokens: null, // Not available in current implementation  
    utilizationPct: null, // Not available in current implementation
    truncated: false // Not available in current implementation
  };

  return { messages, metadata };
}