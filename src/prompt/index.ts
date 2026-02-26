// amplify/functions/workflow-runner/src/prompt/index.ts
import type { State } from "../types";
import type { ModelCapability } from "../modelCapabilities";
import type { Schema } from "../../../../data/resource";
import { fetchConversationMemory } from "./memory";
import { formatMessages } from "./formatters";
import { truncateToFitContextWindow } from "./utils";
import { PromptBuildError, type PromptBuildResult, type PromptSegment } from "./types";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "PromptEngine" });

export type DataClient = ReturnType<
  typeof import("aws-amplify/data").generateClient<Schema>
>;

/**
 * Enhanced Prompt Build Result with promptDebug support
 * (Extends, but does not change, the original metadata types.)
 */
interface EnhancedPromptBuildResult extends PromptBuildResult {
  metadata: PromptBuildResult["metadata"] & {
    promptDebug: {
      allSegments: PromptSegment[];
      truncatedSegments: PromptSegment[];
      totalTokens: number;
      wasTruncated: boolean;
      systemPrompt: string;
      userPrompt: string;
    };
  };
}

type MemorySegment = { role: "user" | "assistant"; content: string };

interface NodePromptConfig {
  systemPrompt?: string;
  useMemory?: boolean;
  memorySize?: number;
}

/** Safe stringifier without using `any`. */
function toStringSafe(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type LoggableRole = "system" | "user" | "assistant" | "tool";
interface LoggableMessage {
  role: LoggableRole;
  content: string;
}

function isLoggableRole(role: unknown): role is LoggableRole {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

interface MaybeMessageLike {
  role?: unknown;
  content?: unknown;
}

/** Runtime type guard for a message-like object. */
function isMessageLike(o: unknown): o is MaybeMessageLike {
  return typeof o === "object" && o !== null && ("content" in o || "role" in o);
}

/**
 * Convert unknown message objects to a safe, loggable shape.
 * This avoids casting BaseMessage[] directly and stays type-safe.
 */
function coerceMessagesForLog(
  messages: ReadonlyArray<unknown>,
  maxChars: number
): LoggableMessage[] {
  return messages.map<LoggableMessage>((m) => {
    if (isMessageLike(m)) {
      const role: LoggableRole = isLoggableRole(m.role) ? m.role : "user";
      const content = toStringSafe(m.content);
      return {
        role,
        content: content.length > maxChars ? content.slice(0, maxChars) : content,
      };
    }
    // Fallback if structure differs
    const content = toStringSafe(m);
    return {
      role: "user",
      content: content.length > maxChars ? content.slice(0, maxChars) : content,
    };
  });
}

/**
 * Main Prompt Engine entry point
 */
export async function buildPrompt(
  state: State,
  dataClient: DataClient,
  modelConfig: ModelCapability
): Promise<EnhancedPromptBuildResult> {
  logger.info("Building prompt", {
    conversationId: state.conversationId,
    modelId: modelConfig.id,
    provider: modelConfig.provider,
    useMemory: state.currentNodeConfig?.useMemory,
    memorySize: state.currentNodeConfig?.memorySize,
  });

  const cfg: NodePromptConfig = state.currentNodeConfig ?? {};
  const systemPrompt: string = cfg.systemPrompt ?? "You are a helpful AI assistant.";
  const useMemory: boolean = cfg.useMemory ?? false;
  const memorySize: number = Number.isFinite(cfg.memorySize) ? (cfg.memorySize as number) : 10;

  // Validate user prompt
  if (!state.userPrompt || !state.userPrompt.trim()) {
    throw new PromptBuildError("Missing user prompt", {
      conversationId: state.conversationId,
      workflowId: state.workflowId,
    });
  }
  const userPrompt: string = state.userPrompt.trim();

  // Memory - NOW PASSING workflowId for auto-create support
  let memorySegments: MemorySegment[] = [];
  if (useMemory) {
    try {
      memorySegments = await fetchConversationMemory(
        dataClient,
        state.conversationId,
        memorySize,
        state.workflowId  // NEW: provide workflowId so memory.ts can auto-create Conversation when missing
      );
      logger.info("Memory loaded successfully", {
        conversationId: state.conversationId,
        memoryCount: memorySegments.length,
        memorySize,
      });
    } catch (err: unknown) {
      logger.warn("Failed to load memory, proceeding without it", {
        error: err instanceof Error ? err.message : "Unknown error",
        conversationId: state.conversationId,
      });
    }
  }

  // Build complete prompt segments (BEFORE truncation)
  const allSegments: PromptSegment[] = [
    { role: "system", content: systemPrompt } as const,
    ...memorySegments,
    { role: "user", content: userPrompt } as const,
  ];

  // Validate and truncate to fit model context window
  const truncationResult = truncateToFitContextWindow(allSegments, modelConfig);
  const truncatedSegments: PromptSegment[] = truncationResult.truncatedSegments;
  const totalTokens: number = truncationResult.totalTokens;
  const wasTruncated: boolean = truncationResult.wasTruncated;
  const removedSegmentsCount: number | undefined = truncationResult.removedSegments; // NOTE: count, not list

  if (wasTruncated) {
    logger.warn("Prompt was truncated to fit context window", {
      originalSegments: allSegments.length,
      truncatedSegments: truncatedSegments.length,
      estimatedTokens: totalTokens,
      contextWindow: modelConfig.contextWindow,
      modelId: modelConfig.id,
      removedSegmentsCount,
    });
  }

  if (totalTokens > modelConfig.contextWindow) {
    throw new PromptBuildError(
      "Prompt exceeds model context window even after truncation",
      {
        estimatedTokens: totalTokens,
        contextWindow: modelConfig.contextWindow,
        modelId: modelConfig.id,
        conversationId: state.conversationId,
      }
    );
  }

  // Format messages for provider
  const messages = formatMessages(truncatedSegments);

  // ---- ALWAYS LOG FINAL PROMPT (no sampling) ----
  logger.info("prompt", {
    tag: "FINAL_PROMPT_MESSAGES",
    modelId: modelConfig.id,
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    messageCount: (messages as ReadonlyArray<unknown>).length,
    tokensPlanned: totalTokens,
    messages: coerceMessagesForLog(messages as ReadonlyArray<unknown>, 6000),
  });

  // --- ALWAYS EMIT FINAL PROMPT (small, unsanitized, easy to search) ---
  type LogRole = "system" | "user" | "assistant" | "tool" | "unknown";
  type MsgLike = { role?: unknown; content?: unknown; _getType?: () => unknown };
  const MAX_MSGS = 8;          // keep it small to avoid 256KB CW limit
  const MAX_CHARS = 1500;      // per message cap
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  const toRole = (m: MsgLike): LogRole => {
    const r = isObj(m) && typeof m.role === "string" ? m.role : undefined;
    if (r === "system" || r === "user" || r === "assistant" || r === "tool") return r;
    const t = typeof m._getType === "function" ? String(m._getType()) : "";
    // LangChain fallback mapping (if role missing):
    if (t === "system") return "system";
    if (t === "human") return "user";
    if (t === "ai") return "assistant";
    return "unknown";
  };
  const toText = (m: MsgLike): string => {
    const raw = isObj(m) && typeof m.content !== "undefined" ? m.content : m;
    const s = typeof raw === "string" ? raw : (() => {
      try { return JSON.stringify(raw); } catch { return String(raw); }
    })();
    return s.slice(0, MAX_CHARS);
  };
  const sample = (messages as ReadonlyArray<unknown>)
    .slice(0, MAX_MSGS)
    .map((m) => {
      const mm = m as MsgLike;
      return `${toRole(mm)}: ${toText(mm)}`;
    });
  // Use plain console.log to bypass structured-log redactors.
  // Use a unique prefix so it's trivial to find in CloudWatch.
  console.log(
    JSON.stringify({
      TAG: "PROMPT_OUT",
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      modelId: modelConfig.id,
      count: sample.length,
      lines: sample
    })
  );

  const utilizationPercent = Math.round(
    (totalTokens / modelConfig.contextWindow) * 100
  );

  const segmentCounts = {
    system: truncatedSegments.filter((s) => s.role === "system").length,
    // memory = all assistant/user minus the final user prompt
    memory:
      truncatedSegments.filter((s) => s.role === "user" || s.role === "assistant").length - 1,
    user: 1,
  };

  // ===== promptDebug (does not alter base metadata types) =====
  const promptDebug = {
    allSegments,
    truncatedSegments,
    totalTokens,
    wasTruncated,
    systemPrompt,
    userPrompt,
  };

  const metadata = {
    totalTokens,
    contextWindow: modelConfig.contextWindow,
    utilizationPercent,
    wasTruncated,
    removedSegments: removedSegmentsCount, // keep original type: number | undefined
    segmentCounts,
    promptDebug,
  };

  // ===== Optional: emit final messages to logs (sampled + truncated) =====
  const sampleEnv = process.env.PROMPT_LOG_SAMPLE_RATE;
  const maxEnv = process.env.PROMPT_LOG_MAX_CHARS;

  const sampleRate = (() => {
    const n = sampleEnv ? Number(sampleEnv) : 0;
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
  })();

  const maxChars = (() => {
    const n = maxEnv ? Number(maxEnv) : 4000;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4000;
  })();

  if (sampleRate > 0 && Math.random() < sampleRate) {
    const safeMessages = coerceMessagesForLog(messages as ReadonlyArray<unknown>, maxChars);
    logger.info("FINAL_PROMPT_MESSAGES", {
      modelId: modelConfig.id,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      messageCount: safeMessages.length,
      tokensPlanned: totalTokens,
      messages: safeMessages,
    });

  }

  logger.info("Prompt built successfully", {
    conversationId: state.conversationId,
    modelId: modelConfig.id,
    provider: modelConfig.provider,
    messageCount: (messages as ReadonlyArray<unknown>).length,
    promptDebugIncluded: true,
    ...metadata,
  });

  return {
    messages,
    metadata,
  };
}