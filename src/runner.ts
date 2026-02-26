// amplify/functions/workflow-runner/src/runner.ts

import type { Logger } from "@aws-lambda-powertools/logger";
import type { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

import { StateGraph, START, END } from "@langchain/langgraph";
import { nodeRegistry } from "./nodeRegistry";
import {
  GraphState,
  type WorkflowDefinition,
  type WorkflowNode,
  type State
} from "./types";

// ✅ FIXED: Use correct relative path
import type { Schema } from "@platform/data/resource";
// ✅ NEW: Import slot state utilities
import { loadSlotState } from "./utils/slotState";

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// ✅ Use proper Amplify data client type with Schema
type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// Type for state with route choice - FIXED: Make __routeChosen required to match GraphState
interface StateWithRoute extends State {
  __routeChosen: string | undefined; // Required but can be undefined
  ownersForProgress: string[]; // Make required to match base State type
}

// Type for node with next property (from database)
interface WorkflowNodeWithNext extends WorkflowNode {
  next?: string;
}

// Type for graph with edge methods (to handle LangGraph typing issues)
interface GraphWithEdgeMethods {
  addEdge: (from: string, to: string) => void;
  addConditionalEdges: (from: string, fn: (state: StateWithRoute) => string | string[] | null | undefined) => void;
}

export interface WorkflowRunParams {
  workflowDefinition: WorkflowDefinition; // UPDATED: Required, no more workflowId
  conversationId: string;
  userPrompt: string;
  userId: string;  // ✅ UPDATED: Required userId from trusted payload
  ownersForProgress: string[]; // ✅ NEW: Array of owners for dual-write progress
  allowedDocumentIds?: string[]; // ✅ NEW: Collection filtering support
  logger: Logger;
  tracer: Tracer;
  metrics: Metrics;
  dataClient: DataClient;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Utilities - REMOVED loadWorkflowDefinition per plan D2
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// ✅ Accept dataClient and ownersForProgress parameters and pass to node handlers
function buildGraph(
  workflowDef: WorkflowDefinition, 
  logger: Logger, 
  dataClient: DataClient,
  ownersForProgress: string[]
) {
  logger.info(`🗂️ Building graph for workflow: ${workflowDef.name}`);
  
  // ✅ Add debugging for dataClient
  console.log("🔍 BuildGraph data client check:", {
    hasModels: !!dataClient.models,
    modelsKeys: dataClient.models ? Object.keys(dataClient.models) : 'undefined',
    modelsCount: dataClient.models ? Object.keys(dataClient.models).length : 0
  });
  
  const graph = new StateGraph(GraphState);

  // Use controlled type assertion for edge operations to avoid complex LangGraph typing issues
  const addEdge = (from: string, to: string) => {
    (graph as unknown as GraphWithEdgeMethods).addEdge(from, to);
  };
  
  const addConditionalEdges = (from: string, fn: (state: StateWithRoute) => string | string[] | null | undefined) => {
    (graph as unknown as GraphWithEdgeMethods).addConditionalEdges(from, fn);
  };

  // 1) Register all nodes
  workflowDef.nodes.forEach((node) => {
    const handler = nodeRegistry[node.type as keyof typeof nodeRegistry];
    if (!handler) throw new Error(`❌ Unknown node type: ${node.type}`);

    // ✅ Pass dataClient and ownersForProgress to the node handler
    const nodeFn = async (state: StateWithRoute) => {
      // ✅ Add debugging before calling handler
      console.log(`🔍 Node ${node.id} data client check:`, {
        hasModels: !!dataClient.models,
        hasConversation: !!dataClient.models?.Conversation,
        hasMemory: !!dataClient.models?.Memory,
        modelsKeys: dataClient.models ? Object.keys(dataClient.models) : 'undefined'
      });
      
      const nextState = await handler({
        ...state,
        workflowDefinition: workflowDef,
        currentNodeConfig: node.config ?? {},
        currentNodeId: node.id,
        currentNodeType: node.type,
        ownersForProgress, // ✅ NEW: Pass context for dual-write logging
      }, dataClient);

      // Only clear userPrompt if the node is explicitly awaiting user input.
      // We must preserve SlotTracker's synthesis seed for the next ModelInvoke.
      if (nextState && '__needsUserInput' in nextState && nextState.__needsUserInput) {
        (nextState as { userPrompt?: string }).userPrompt = undefined;
      }

      return nextState;
    };

    graph.addNode(node.id, nodeFn);
  });

  // 2) Resolve entry
  const entry =
    workflowDef.nodes.find((n) => n.id === workflowDef.entryPoint) ??
    workflowDef.nodes.find((n) => n.type === workflowDef.entryPoint);
  if (!entry) throw new Error(`Entry point ${workflowDef.entryPoint} not found`);
  addEdge(START, entry.id);

  // 3) Track Router and SlotTracker ids to add conditional edges later
  const routerNodeIds = new Set(
    workflowDef.nodes
      .filter((n) => n.type === "Router" || n.type === "router")
      .map((n) => n.id)
  );
  const slotTrackerNodeIds = new Set(
    workflowDef.nodes
      .filter((n) => n.type === "SlotTracker" || n.type === "slot_tracker")
      .map((n) => n.id)
  );

  // 4) Convert ad-hoc "next" pointers → edges, **skipping Router and SlotTracker**
  logger.info("🔗 Converting next pointers to edges (non-Router, non-SlotTracker)");
  workflowDef.nodes.forEach((node) => {
    const nodeWithNext = node as WorkflowNodeWithNext;
    if (nodeWithNext.next && !routerNodeIds.has(node.id) && !slotTrackerNodeIds.has(node.id)) {
      logger.info(`🔗 Edge from next pointer: ${node.id} → ${nodeWithNext.next}`);
      addEdge(node.id, nodeWithNext.next);
    }
  });

  // 5) Add edges from definition, **skipping Router and SlotTracker sources**
  logger.info("🔗 Adding edges from edges array (non-Router, non-SlotTracker)");
  workflowDef.edges.forEach((e) => {
    if (routerNodeIds.has(e.from) || slotTrackerNodeIds.has(e.from)) {
      logger.info(`⏭️ Skipping static edge from conditional node: ${e.from} → ${e.to}`);
      return;
    }
    logger.info(`🔗 Edge: ${e.from} → ${e.to}`);
    addEdge(e.from, e.to);
  });

  // 6) For each Router node, add a single **conditional** edge
  routerNodeIds.forEach((routerId) => {
    logger.info(`🧭 Adding conditional edge for Router: ${routerId}`);
    addConditionalEdges(routerId, (state: StateWithRoute) => {
      const chosen = state.__routeChosen;
      // Return exactly one next node id (or null to stop)
      return typeof chosen === "string" && chosen.length > 0 ? chosen : null;
    });
  });

  // 7) For each SlotTracker node, add a conditional edge:
  //    - if allSlotsFilled → go to its first declared next node
  //    - else → END (halt this run cleanly, awaiting user input)
  slotTrackerNodeIds.forEach((slotId) => {
    const outgoing = workflowDef.edges.filter((e) => e.from === slotId).map((e) => e.to);
    const firstTarget = outgoing[0]; // SlotTracker should have exactly one next node
    logger.info(`🧩 Adding conditional edge for SlotTracker: ${slotId} → ${firstTarget ?? "∅"} (or END if awaiting input)`);
    addConditionalEdges(slotId, (state: StateWithRoute) => {
      // If all slots filled, proceed to the next node; otherwise end this invocation
      return state.allSlotsFilled && firstTarget ? firstTarget : END;
    });
  });

  // 8) Add END edges for terminal nodes (StreamToClient)
  workflowDef.nodes.forEach((n) => {
    if (n.type === "StreamToClient" || n.type === "stream_to_client") {
      logger.info(`🏁 Adding end edge for terminal node: ${n.id} → END`);
      addEdge(n.id, END);
    }
  });

  return graph;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Main Runner - UPDATED per plan D2
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const runWorkflow = async ({
  workflowDefinition, // UPDATED: Required, no workflowId
  conversationId,
  userPrompt,
  userId,   // ✅ UPDATED: Extract userId from payload
  ownersForProgress, // ✅ NEW: Owners for dual-write progress
  allowedDocumentIds, // ✅ NEW: Collection filtering support
  logger,
  tracer,
  metrics,
  dataClient,
}: WorkflowRunParams): Promise<void> => {
  logger.appendKeys({ workflowId: workflowDefinition.id ?? "adhoc", conversationId, userId });
  
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
    tracer.putAnnotation("WorkflowId", workflowDefinition.id ?? "adhoc");
  }
  
  logger.info("🚀 Starting workflow run with access control context", {
    ownersForProgress: ownersForProgress.length,
    dualWriteEnabled: ownersForProgress.length > 1,
    hasCollectionFilter: !!(allowedDocumentIds && allowedDocumentIds.length > 0),
    allowedDocumentCount: allowedDocumentIds?.length ?? 0
  });

  try {
    // REMOVED: No workflow loading here per plan D2
    metrics.addMetric("WorkflowLoaded", MetricUnit.Count, 1);

    // ✅ NEW: Write initial visible status to confirm pipeline works end-to-end
    // This creates a known-good row that should appear immediately in the UI
    try {
      await dataClient.models.WorkflowProgress.create({
        workflowId: workflowDefinition.id ?? 'adhoc',
        conversationId,
        owner: userId,
        stepName: 'System',
        status: 'INFO',
        message: 'Runner started',
        metadata: JSON.stringify({
          userVisible: true,
          nodeType: 'System',
          ui: { 
            kind: 'status', 
            title: 'Runner started', 
            body: 'Initializing workflow…' 
          }
        }),
        eventTime: new Date().toISOString(),
      });
      logger.info("✅ Initial visible status written");
    } catch (statusErr) {
      logger.warn("⚠️ Failed to write initial status (non-fatal)", statusErr as Error);
    }

    // ✅ NEW: Load persisted slot state from Conversation.metadata
    const persistedSlotState = await loadSlotState(dataClient, conversationId);
    
    logger.info("Loaded slot state from metadata", {
      hasPersistedSlots: Object.keys(persistedSlotState.slotValues || {}).length > 0,
      persistedSlotCount: Object.keys(persistedSlotState.slotValues || {}).length,
      currentSlotKey: persistedSlotState.currentSlotKey,
      allSlotsFilled: persistedSlotState.allSlotsFilled,
    });

    // ── Run LangGraph with userId from trusted payload ──
    const initialState: StateWithRoute = {
      userId,                     // ✅ UPDATED: Populate from trusted payload
      allowedDocumentIds: allowedDocumentIds ?? [], // ✅ NEW: Collection filtering
      workflowId: workflowDefinition.id,
      conversationId,
      userPrompt,
      memory: [],
      modelResponse: "",
      formattedResponse: "",
      workflowDefinition,
      currentNodeConfig: {},
      currentNodeId: "",
      currentNodeType: "",
      contextMeta: undefined, 
      // ✅ NEW: Hydrate from persisted state
      slotValues: persistedSlotState.slotValues ?? {},
      slotAttempts: persistedSlotState.slotAttempts ?? {},
      currentSlotKey: persistedSlotState.currentSlotKey ?? "",
      allSlotsFilled: persistedSlotState.allSlotsFilled ?? false,
      intent: "",
      intentConfidence: undefined,
      nextNode: "",
      routingReason: "",
      ownersForProgress, // ✅ NEW: Include context in state
      __routeChosen: undefined, // ✅ CRITICAL FIX: Initialize as required field
      __needsUserInput: undefined, // ✅ NEW: Signal to halt and await user input
      awaitingInputFor: undefined, // ✅ NEW: Track which slot is awaiting input
      inputCursor: 0, // ✅ NEW: Monotonic cursor for consumed prompts
      input: undefined, // ✅ NEW: Data passed between nodes via template interpolation
    };
    
    // ✅ DEBUG: Log userId presence once for verification
    logger.debug("State initialized with userId and access control context", { 
      hasUserId: !!initialState.userId,
      ownersCount: ownersForProgress.length,
      owners: ownersForProgress,
      allowedDocumentIdsCount: initialState.allowedDocumentIds.length
    });
    
    // ✅ Pass dataClient and ownersForProgress to buildGraph - streaming stays wired exactly as before
    const graph = buildGraph(workflowDefinition, logger, dataClient, ownersForProgress).compile();
    await graph.invoke(initialState);

    metrics.addMetric("WorkflowSucceeded", MetricUnit.Count, 1);
    logger.info("✅ Workflow completed successfully");
  } catch (err) {
    metrics.addMetric("WorkflowFailed", MetricUnit.Count, 1);
    logger.error("❌ Workflow failure", err as Error);
    throw err;
  }
};