// amplify/functions/workflow-runner/src/utils/progress.ts
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "ProgressWriter" });

export interface ProgressInput {
  workflowId: string;
  conversationId?: string;
  stepName?: string;
  status?: string;
  message?: string;
  metadata?: string; // JSON string
  eventTime?: string; // optional in input, but enforced in write
}

export interface WorkflowProgressCreateInput extends ProgressInput {
  owner: string;     // required by model auth
  eventTime: string; // required by model (always set by helper)
}

export interface WorkflowProgressModel {
  create(input: WorkflowProgressCreateInput): Promise<{ data: unknown }>;
}

export interface ModelsWithProgress {
  WorkflowProgress: WorkflowProgressModel;
}

export interface DataClientWithProgress {
  models: ModelsWithProgress;
}

// Optional state context that may contain requestId
export interface WorkflowState {
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Writes one WorkflowProgress row per owner (deduped).
 * - Always sets eventTime (ISO) if not provided.
 * - Enriches metadata with conversationId and requestId for client-side filtering.
 * - Never mutates/overrides the provided conversationId.
 * - Logs per-owner success/failure for easy correlation.
 * - When options.persist === false, skips per-chunk streaming writes (used by unauth SSE)
 */
export async function logProgressForOwners(
  client: DataClientWithProgress,
  owners: ReadonlyArray<string>,
  input: ProgressInput,
  options?: { persist?: boolean; state?: WorkflowState }
): Promise<void> {
  // Skip per-chunk streaming writes when persist === false (used by unauth SSE path)
  if (options?.persist === false && (input.status === 'STREAMING' || input.status === 'token')) {
    return;
  }

  // Deduplicate, trim, and filter invalid owners
  const uniqueOwners = Array.from(
    new Set(
      (owners ?? [])
        .map((o) => (typeof o === "string" ? o.trim() : ""))
        .filter((o) => o.length > 0)
    )
  );

  if (uniqueOwners.length === 0) {
    logger.warn("No valid owners provided for progress logging", {
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      stepName: input.stepName,
      status: input.status,
    });
    return;
  }

  // Enforce eventTime on every write
  const enforcedEventTime = input.eventTime ?? new Date().toISOString();

  // Parse existing metadata (safely handle invalid JSON)
  const baseMeta = (() => {
    try {
      return input.metadata ? JSON.parse(String(input.metadata)) : {};
    } catch {
      return {};
    }
  })();

  // Enrich metadata with conversationId and requestId for precise client-side filtering
  const enrichedMetadata = JSON.stringify({
    ...baseMeta,
    // Ensure both are present for client-side filtering
    conversationId: input.conversationId,
    requestId: options?.state?.requestId ?? baseMeta.requestId,
  });

  // Base payload used for each owner (do NOT alter conversationId)
  const base: Omit<WorkflowProgressCreateInput, "owner"> = {
    ...input,
    eventTime: enforcedEventTime,
    metadata: enrichedMetadata,
  };

  logger.info("[ProgressWriter] Writing progress", {
    workflowId: input.workflowId,
    conversationId: input.conversationId, // <-- same-ID debug trail
    stepName: input.stepName,
    status: input.status,
    owners: uniqueOwners,
    eventTime: enforcedEventTime,
    hasRequestId: Boolean(options?.state?.requestId ?? baseMeta.requestId),
  });

  // Write progress for each owner
  const writePromises = uniqueOwners.map((owner) =>
    client.models.WorkflowProgress.create({
      ...base,
      owner,
    })
  );

  const results = await Promise.allSettled(writePromises);

  results.forEach((result, index) => {
    const owner = uniqueOwners[index];
    if (result.status === "rejected") {
      logger.error("Failed to write progress", {
        owner,
        workflowId: input.workflowId,
        conversationId: input.conversationId,
        stepName: input.stepName,
        status: input.status,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    } else {
      logger.debug("Progress written", {
        owner,
        workflowId: input.workflowId,
        conversationId: input.conversationId,
        stepName: input.stepName,
        status: input.status,
        eventTime: enforcedEventTime,
      });
    }
  });
}