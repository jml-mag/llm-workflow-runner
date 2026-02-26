// amplify/functions/workflow-runner/src/nodes/ConversationMemory.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";

import type { State } from "../types";
import type { Schema } from "@platform/data/resource";
import { logProgressForOwners } from "../utils/progress";

// Ensure explicit service name to avoid 'service_undefined' logs
const logger = new Logger({ serviceName: 'ConversationMemory' });
const tracer = new Tracer({ serviceName: 'ConversationMemory' });
const metrics = new Metrics({ serviceName: 'ConversationMemory' });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

export const handleConversationMemory = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "ConversationMemory");
  logger.info("Node: ConversationMemory — loading conversation history");

  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "ConversationMemory",
    status: "STARTED",
    message: "Loading memory…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Memory", 
        body: "Loading memory…" 
      } 
    })
  });

  try {
    // 3. Do the work - load conversation history
    let conversationResult = await dataClient.models.Conversation.get({
      id: state.conversationId,
    });

    // Auto-create conversation if missing (guest/public first-turn)
    if (!conversationResult.data) {
      logger.warn("Conversation not found. Auto-creating for memory continuity.", {
        conversationId: state.conversationId,
        workflowId: state.workflowId,
      });

      const createRes = await dataClient.models.Conversation.create({
        id: state.conversationId,
        workflowId: state.workflowId,
        status: "ACTIVE",
      });

      if (!createRes.data) {
        logger.error("Failed to auto-create Conversation", {
          conversationId: state.conversationId,
          workflowId: state.workflowId,
        });
        // Continue gracefully with empty history
      } else {
        logger.info("Auto-created Conversation for memory continuity", {
          conversationId: state.conversationId,
          workflowId: state.workflowId,
          status: "ACTIVE",
        });
        // Re-fetch to get a model instance that supports .memories()
        conversationResult = await dataClient.models.Conversation.get({
          id: state.conversationId,
        });
      }
    }

    metrics.addMetric("MemoryReads", MetricUnit.Count, 1);

    const history: { role: "user" | "assistant"; content: string }[] = [];

    if (conversationResult.data) {
      const memoriesResult = await conversationResult.data.memories();
      if (memoriesResult.data) {
        const sortedItems = memoriesResult.data.sort(
          (a, b) =>
            new Date(a.timestamp || "").getTime() -
            new Date(b.timestamp || "").getTime()
        );

        sortedItems.forEach((item) => {
          if (item.role === "user" || item.role === "assistant") {
            history.push({
              role: item.role,
              content: String(item.content ?? ""),
            });
          }
        });
      }
    }

    logger.info(`ConversationMemory — found ${history.length} previous messages`);

    metrics.addMetric("MemoryReadSuccess", MetricUnit.Count, 1);
    logger.info("ConversationMemory — history assembled for prompt build");

    const mergedMemory: { role: "user" | "assistant"; content: string }[] = [
      ...history,
      { role: "user", content: state.userPrompt },
    ];

    // Calculate memory statistics for debugging
    const memoryStats = {
      totalMemories: mergedMemory.length,
      userMessages: mergedMemory.filter(m => m.role === "user").length,
      assistantMessages: mergedMemory.filter(m => m.role === "assistant").length,
      totalCharacters: mergedMemory.reduce((sum, m) => sum + m.content.length, 0),
      averageMessageLength: mergedMemory.length > 0 ? 
        Math.round(mergedMemory.reduce((sum, m) => sum + m.content.length, 0) / mergedMemory.length) : 0,
      oldestMessage: history.length > 0 ? history[0].content.substring(0, 50) + "..." : "none",
      newestMessage: state.userPrompt.substring(0, 50) + (state.userPrompt.length > 50 ? "..." : "")
    };

    const prevItems = history.length;
    const total = mergedMemory.length;

    // 4. Emit COMPLETED with counts
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "ConversationMemory",
      status: "COMPLETED",
      message: "Memory ready",
      metadata: JSON.stringify({
        userVisible: true,
        ui: { 
          kind: "chips", 
          title: "Prev:", 
          items: [`Prev: ${prevItems}`, `Total: ${total}`] 
        },
        // Structured metadata for telemetry
        previousMemoryCount: history.length,
        conversationExists: !!conversationResult.data,
        userPromptSaved: true,
        totalMemoryAfterAdd: mergedMemory.length,
        memoryStats,
        conversationId: state.conversationId
      })
    });

    return { memory: mergedMemory };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    
    logger.error("ConversationMemory failed", err as Error);

    // 5. Emit ERROR on failure (and return fallback)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "ConversationMemory",
      status: "ERROR",  
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: err instanceof Error ? err.stack : undefined,
        fallbackMemoryProvided: true,
        conversationId: state.conversationId,
        attemptedOperation: "load_conversation_history"
      })
    });

    metrics.addMetric("ConversationMemoryErrors", MetricUnit.Count, 1);

    // Return fallback memory even on error
    return { memory: [{ role: "user", content: state.userPrompt }] };
  }
};