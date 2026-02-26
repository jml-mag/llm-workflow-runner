// amplify/functions/workflow-runner/src/workflowRunnerHandler.ts
import { createDataClient, type DataClient } from "./adapters/dataClient";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { runWorkflow } from "./runner";
import type { WorkflowDefinition } from "./types";
import { LoadedWorkflow } from "./utils/graphqlClient";
import { RequestUser } from "./utils/access";

// --------------------------------------------------
//  Observability
// --------------------------------------------------
const logger  = new Logger({ serviceName: "workflowRunnerHandler" });
const tracer  = new Tracer({ serviceName: "workflowRunnerHandler" });
const metrics = new Metrics({ serviceName: "workflowRunnerHandler" });

// Safe tracer annotation helper — avoid Lambda "main segment" warnings when putAnnotation is not allowed
function safePutAnnotation(tracerInstance: Tracer, key: string, value: string | number | boolean) {
  try {
    tracerInstance.putAnnotation(key, value);
  } catch (err) {
    logger.debug("Tracer annotation skipped", { key, value, err: err instanceof Error ? err.message : String(err) });
  }
}

// --------------------------------------------------
//  Lambda event types
// --------------------------------------------------

// Accept payload from API handler per plan D1
interface WorkflowRunnerEvent {
  workflow: LoadedWorkflow;
  userPrompt: string;
  conversationId?: string;
  collections?: string[];
  isPublic: boolean;
  user?: RequestUser;
  /** Optional explicit owners list set by the API handler; if provided, this wins */
  ownersForProgress?: string[];
}

// A small helper type for the query result shape we need
type DocumentsByCollectionResult = {
  data?: {
    items?: Array<{ documentId?: string | null } | null> | null;
    nextToken?: string | null;
  } | null;
};

// --------------------------------------------------
//  Small utils
// --------------------------------------------------
const dedupe = <T,>(xs: readonly T[]): T[] => Array.from(new Set(xs));
const notEmpty = <T,>(x: T | null | undefined): x is T =>
  x !== null && x !== undefined && (typeof x !== "string" || x.length > 0);

function ensureConversationId(fromEvent?: string): string {
  if (fromEvent && typeof fromEvent === "string" && fromEvent.length > 0) return fromEvent;
  // Fallback only if client didn't provide one (client SHOULD send one)
  const rnd = Math.floor(Math.random() * 1e6);
  // Prefer crypto.randomUUID when available in Node 20+
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID() as string;
  return `conv_${Date.now()}_${rnd}`;
}

// --------------------------------------------------
//  Collection Resolution Logic
// --------------------------------------------------
async function resolveAllowedDocumentIds(
  dataClient: DataClient,
  inputCollectionId?: string,
  inputCollectionIds?: string[],
  actorId?: string
): Promise<string[]> {
  if (!inputCollectionId && (!inputCollectionIds || inputCollectionIds.length === 0)) {
    return []; // No collection filter
  }

  const collect = async (collectionId: string): Promise<string[]> => {
    // Verify collection exists and (if owned) that actor matches
    const col = await dataClient.models.Collection.get({ id: collectionId });
    if (!col.data) {
      throw new Error(`Collection not found: ${collectionId}`);
    }
    const collectionData = col.data as { owner?: string | null };
    if (collectionData.owner && actorId && collectionData.owner !== actorId) {
      throw new Error(`FORBIDDEN: You do not own collection ${collectionId}`);
    }

    // Resolve document IDs from collection membership (paginated)
    const docs: string[] = [];
    let nextToken: string | undefined = undefined;
    do {
      const res: DocumentsByCollectionResult =
        await (dataClient.queries as unknown as {
          documentsByCollection: (args: { collectionId: string; limit?: number; nextToken?: string }) => Promise<DocumentsByCollectionResult>;
        }).documentsByCollection({ collectionId, limit: 100, nextToken });

      nextToken = res.data?.nextToken ?? undefined;
      for (const item of res.data?.items ?? []) {
        const docId = item?.documentId ?? null;
        if (docId) docs.push(docId);
      }
    } while (nextToken);

    return docs;
  };

  // Combine all collection IDs
  const allCollectionIds = dedupe([
    ...(inputCollectionId ? [inputCollectionId] : []),
    ...(inputCollectionIds ?? []),
  ]);

  logger.info("Resolving document IDs from collections", { collectionIds: allCollectionIds, actorId });

  // Resolve all collections in parallel, flatten, dedupe
  const perCollection = await Promise.all(allCollectionIds.map(collect));
  const allDocumentIds = dedupe(perCollection.flat());

  logger.info("Resolved allowed document IDs", {
    collectionCount: allCollectionIds.length,
    documentCount: allDocumentIds.length,
    actorId,
  });

  return allDocumentIds;
}

// --------------------------------------------------
//  Owners resolution (honors explicit list, supports public dual-write)
// --------------------------------------------------
function resolveOwnersForProgress(event: WorkflowRunnerEvent): string[] {
  // If API handler already computed this, honor it as source of truth.
  if (event.ownersForProgress && event.ownersForProgress.length > 0) {
    return dedupe(event.ownersForProgress.filter(notEmpty));
  }

  // Public runs: dual-write to workflow.owner and the public marker.
  // If an authenticated user exists and we want them to see it in their history, include them too.
  if (event.isPublic) {
    return dedupe([event.user?.userId, "public-run", event.workflow?.owner].filter(notEmpty));
  }

  // Private/authenticated runs: write to the actor and (optionally) workflow owner if present.
  return dedupe([event.user?.userId, event.workflow?.owner].filter(notEmpty));
}

// --------------------------------------------------
//  Handler
// --------------------------------------------------
export const handler = async (event: WorkflowRunnerEvent) => {
  logger.info("🚀 workflowRunner invoked", {
    workflowId: event.workflow?.id,
    isPublic: event.isPublic,
    hasUser: !!event.user,
    userPromptLength: event.userPrompt?.length ?? 0,
  });
  metrics.addMetric("WorkflowInvoked", MetricUnit.Count, 1);

  // Basic input validation - allow empty userPrompt for bootstrap/slot tracker runs
  if (!event.workflow || !event.workflow.id) {
    logger.error("❌ Missing required workflow.id");
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: {
          code: "BAD_REQUEST",
          message: "Missing required field: workflow.id",
        },
      }),
    };
  }

  // userPrompt can be empty string for bootstrap runs - this is valid!
  const userPrompt = event.userPrompt ?? "";

  try {
    // Initialise Amplify Data client via adapter (IAM-signed in Lambda)
    const dataClient = await createDataClient();

    // Sanity-check models we rely on
    const required = [
      "Conversation",
      "Memory",
      "Workflow",
      "WorkflowProgress",
      "WorkflowAccess",
      "Collection",
      "CollectionMembership",
    ] as const;
    const missing = required.filter((m) => !(m in dataClient.models));
    if (missing.length) {
      logger.error("❌ Required models missing", { missing });
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing data models", missing }),
      };
    }

    const workflowId = event.workflow.id;
    const conversationId = ensureConversationId(event.conversationId);
    const actorId = event.user?.userId || (event.isPublic ? "public" : "unknown");
    const ownersForProgress = resolveOwnersForProgress(event);

    // ── Resolve allowedDocumentIds from collections ──
    let allowedDocumentIds: string[] | undefined = undefined;
    try {
      const resolved = await resolveAllowedDocumentIds(
        dataClient,
        undefined,
        event.collections,
        actorId
      );

      if (resolved.length > 0) {
        allowedDocumentIds = resolved;
        logger.info("Collection filtering enabled", {
          documentCount: resolved.length,
          actorId,
        });
        metrics.addMetric("WorkflowWithCollectionFilter", MetricUnit.Count, 1);
      }
    } catch (error) {
      logger.error("Collection resolution failed", {
        collections: event.collections,
        actorId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Fail early on collection access issues
      return {
        statusCode: 403,
        body: JSON.stringify({
          ok: false,
          code: "COLLECTION_ACCESS_DENIED",
          message: error instanceof Error ? error.message : "Collection access failed",
        }),
      };
    }

    logger.info("🚦 Starting workflow run", {
      workflowId,
      conversationId,
      userId: actorId,
      userPromptLength: userPrompt.length,
      isBootstrap: userPrompt.length === 0,
      ownersForProgressCount: ownersForProgress.length,
      ownersForProgress, // <— explicit array for acceptance checks
      dualWritePublic: ownersForProgress.includes("public-run"),
      hasCollectionFilter: Array.isArray(allowedDocumentIds),
      allowedDocumentCount: allowedDocumentIds?.length ?? 0,
    });

    // Tracing annotations (safe)
    safePutAnnotation(tracer, "WorkflowId", workflowId);
    safePutAnnotation(tracer, "ConversationId", conversationId);
    safePutAnnotation(tracer, "ActorId", actorId);
    safePutAnnotation(tracer, "IsBootstrap", userPrompt.length === 0);
    safePutAnnotation(tracer, "DualWritePublic", ownersForProgress.includes("public-run"));
    safePutAnnotation(tracer, "HasCollectionFilter", !!allowedDocumentIds?.length);

    // Convert LoadedWorkflow -> WorkflowDefinition (pass-through)
    const workflowDefinition: WorkflowDefinition = {
      id: event.workflow.id,
      name: event.workflow.name,
      entryPoint: event.workflow.entryPoint,
      nodes: event.workflow.nodes as unknown as WorkflowDefinition["nodes"],
      edges: event.workflow.edges as unknown as WorkflowDefinition["edges"],
    };

    // Kick off the graph execution
    await runWorkflow({
      workflowDefinition,
      conversationId,
      userPrompt, // Now properly defaults to empty string for bootstrap
      userId: actorId,
      ownersForProgress,
      allowedDocumentIds, // only set when non-empty; undefined means "no filter"
      logger,
      tracer,
      metrics,
      dataClient: dataClient as Parameters<typeof runWorkflow>[0]["dataClient"],
    });

    metrics.addMetric("WorkflowSucceeded", MetricUnit.Count, 1);
    logger.info("✅ Workflow completed successfully", {
      workflowId,
      conversationId,
      userId: actorId,
    });

    // 202 Accepted: run kicked off successfully
    return { statusCode: 202, body: JSON.stringify({ ok: true, message: "Workflow run accepted" }) };
  } catch (err) {
    logger.error("❌ Workflow failed", err as Error);
    metrics.addMetric("WorkflowFailed", MetricUnit.Count, 1);
    return { statusCode: 500, body: JSON.stringify({ error: (err as Error).message }) };
  }
};