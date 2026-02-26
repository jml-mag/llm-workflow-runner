// amplify/functions/workflow-runner/src/nodes/StreamToClient.ts

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { State } from "../types";
import type { Schema } from "../../../../data/resource";
import { logProgressForOwners } from "../utils/progress";

// Ensure explicit service name to avoid 'service_undefined' logs
const logger = new Logger({ serviceName: "StreamToClient" });
const tracer = new Tracer({ serviceName: "StreamToClient" });
const metrics = new Metrics({ serviceName: "StreamToClient" });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// Narrow the fields we log from WorkflowProgress list results
type WorkflowProgressListItem = Pick<Schema["WorkflowProgress"]["type"], "id" | "createdAt">;

/**
 * StreamToClient Node Handler
 *
 * Ensures SINGLE finalization per conversation to prevent duplicate responses.
 * Checks for existing final responses before proceeding with completion.
 * Uses the SAME conversationId provided by the POST request (debug-logged).
 */
export const handleStreamToClient = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "StreamToClient");

  // --- Same-ID debug log for correlation with POST + SSE ---
  logger.info("[StreamToClient] start", {
    workflowId: state.workflowId,
    conversationId: state.conversationId, // <-- correlate against POST & SSE
    userId: state.userId,
  });

  if (!state.conversationId) {
    logger.warn("[StreamToClient] Missing conversationId on state; proceeding but writes may be orphaned", {
      workflowId: state.workflowId,
    });
  }

  // Resolve owners: prefer precomputed ownersForProgress; otherwise fall back to actor.
  // For public runs, ownersForProgress should include "public-run" (set by API handler).
  const owners = Array.from(
    new Set(
      (state.ownersForProgress && state.ownersForProgress.length > 0
        ? state.ownersForProgress
        : [state.userId]
      ).filter(Boolean)
    )
  );

  // ===== CHECK FOR EXISTING FINAL RESPONSE TO PREVENT DUPLICATES =====
  try {
    const existingFinal = await dataClient.models.WorkflowProgress.list({
      filter: {
        and: [
          { workflowId: { eq: state.workflowId } },
          { conversationId: { eq: state.conversationId } },
          { stepName: { eq: "StreamToClient" } },
          { status: { eq: "COMPLETED" } },
        ],
      },
      limit: 1,
    });

    const firstItem: WorkflowProgressListItem | undefined =
      (existingFinal.data as WorkflowProgressListItem[] | undefined)?.[0];

    if (firstItem) {
      logger.info("[StreamToClient] Final response already sent, skipping duplicate", {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        existingResponseId: firstItem.id,
        existingTimestamp: firstItem.createdAt,
        preventedDuplicate: true,
      });

      metrics.addMetric("DuplicateFinalizationsPrevented", MetricUnit.Count, 1);
      return {}; // Exit early to prevent duplicate finalization
    }
  } catch (duplicateCheckError) {
    logger.warn("[StreamToClient] Duplicate check failed, proceeding with caution", {
      error:
        duplicateCheckError instanceof Error
          ? duplicateCheckError.message
          : "Unknown error",
      workflowId: state.workflowId,
      conversationId: state.conversationId,
    });
    // Continue — better to risk duplicate than block legitimate response
  }

  // STARTED marker (helper enforces eventTime)
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "StreamToClient",
    status: "STARTED",
    message: "Streaming response to client",
    metadata: JSON.stringify({
      duplicateCheckPassed: true,
      owners,
      ownersCount: owners.length,
      timestamp: new Date().toISOString(),
    }),
  });

  const fullResponse = state.formattedResponse || state.modelResponse || "";

  try {
    logger.info("📤 [StreamToClient] Sending final response to client", {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      responseLength: fullResponse.length,
      hasContent: fullResponse.trim().length > 0,
      owners,
    });

    if (fullResponse.trim()) {
      // SINGLE FINALIZATION: Mark conversation as completed
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "StreamToClient",
        status: "COMPLETED",
        message: fullResponse,
        metadata: JSON.stringify({
          responseLength: fullResponse.length,
          workflowCompleted: true,
          hasContent: true,
          userId: state.userId,
          workflowId: state.workflowId,
          responsePreview:
            fullResponse.substring(0, 200) +
            (fullResponse.length > 200 ? "..." : ""),
          owners,
          ownersCount: owners.length,
          dualWriteEnabled: owners.length > 1,
          baseSystemPromptUsed: true,
          timestamp: new Date().toISOString(),
          singleFinalization: true,
          finalResponseSent: true,
        }),
      });

      metrics.addMetric("WorkflowsCompleted", MetricUnit.Count, 1);
      metrics.addMetric("ResponseLength", MetricUnit.Count, fullResponse.length);
      metrics.addMetric("SingleFinalizations", MetricUnit.Count, 1);

      logger.info("✅ [StreamToClient] Final response sent - conversation completed", {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        userId: state.userId,
        totalLength: fullResponse.length,
        ownersCount: owners.length,
        singleFinalization: true,
      });
    } else {
      logger.warn("⚠️ [StreamToClient] No formatted response available to send", {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        modelResponse: state.modelResponse || "none",
        formattedResponse: state.formattedResponse || "none",
      });

      // Still mark as completed to prevent retry loops
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "StreamToClient",
        status: "COMPLETED",
        message: "No formatted response available to send",
        metadata: JSON.stringify({
          responseLength: 0,
          hasContent: false,
          warning: "empty_response",
          modelResponse: state.modelResponse || "none",
          modelResponseLength: (state.modelResponse || "").length,
          owners,
          ownersCount: owners.length,
          singleFinalization: true,
          emptyResponseHandled: true,
        }),
      });

      metrics.addMetric("EmptyResponsesHandled", MetricUnit.Count, 1);
    }

    return {}; // Nothing more to propagate - workflow complete
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error in StreamToClient";

    logger.error("[StreamToClient] FAILED", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      responseLength: fullResponse.length,
    });

    // Error marker (helper enforces eventTime)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "StreamToClient",
      status: "ERROR",
      message: `Stream to client failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        responseLength: fullResponse.length,
        userId: state.userId,
        workflowId: state.workflowId,
        owners,
        ownersCount: owners.length,
        failedFinalization: true,
      }),
    });

    metrics.addMetric("StreamToClientErrors", MetricUnit.Count, 1);
    throw error;
  }
};
