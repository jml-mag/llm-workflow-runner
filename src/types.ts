// amplify/functions/workflow-runner/src/types.ts
import { Annotation } from "@langchain/langgraph";

export interface WorkflowDefinition {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  entryPoint: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: NodeConfig;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
}

export type RoleType = "user" | "assistant";

export interface NodeConfig {
  name?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  useMemory?: boolean;
  memorySize?: number;
  outputFormat?: "json" | "text" | "markdown";
  searchQuery?: string;
  resultCount?: number;
  modelId?: string;
  streaming?: boolean;

  // SlotTracker
  slots?: Array<{
    key: string;
    prompt: string;
    required: boolean;
    validation?: string;
    validationHint?: string;
    maxRetries?: number;
  }>;
  allowPartial?: boolean;
  persistToState?: boolean;
  maxTotalAttempts?: number;
  fallbackRoute?: string;

  // IntentClassifier
  intents?: string[];
  fallbackIntent?: string;
  includeConfidence?: boolean;
  confidenceThreshold?: number;

  // Router
  routes?: Array<{
    condition: string;
    target: string;
    description?: string;
    priority?: number;
  }>;
  defaultRoute?: string;
  enableDetailedLogging?: boolean;
  evaluateAllConditions?: boolean;
}

export const GraphState = Annotation.Root({
  userId: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  allowedDocumentIds: Annotation<string[]>({
    value: (_: string[], update: string[]) => update,
    default: () => [],
  }),
  workflowId: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  conversationId: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  userPrompt: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  memory: Annotation<{ role: "user" | "assistant"; content: string }[]>({
    value: (left, right) => left.concat(right),
    default: () => [],
  }),
  modelResponse: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  formattedResponse: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  workflowDefinition: Annotation<WorkflowDefinition>({
    value: (_: WorkflowDefinition, update: WorkflowDefinition) => update,
    default: () => ({
      id: "",
      name: "",
      nodes: [],
      edges: [],
      entryPoint: "",
    }),
  }),
  currentNodeConfig: Annotation<NodeConfig>({
    value: (_: NodeConfig, update: NodeConfig) => ({ ...update }),
    default: () => ({}),
  }),
  currentNodeId: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  currentNodeType: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),

  // Slot tracking
  slotValues: Annotation<Record<string, string>>({
    value: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  slotAttempts: Annotation<Record<string, number>>({
    value: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  currentSlotKey: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  allSlotsFilled: Annotation<boolean>({
    value: (_: boolean, update: boolean) => update,
    default: () => false,
  }),

  // Intent
  intent: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  intentConfidence: Annotation<number | undefined>({
    value: (_: number | undefined, update: number | undefined) => update,
    default: () => undefined,
  }),

  // Routing
  nextNode: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),
  routingReason: Annotation<string>({
    value: (_: string, update: string) => update,
    default: () => "",
  }),

  // Access / progress
  ownersForProgress: Annotation<string[]>({
    value: (_: string[], update: string[]) => update,
    default: () => [],
  }),

  // Router communication - CRITICAL FIX
  __routeChosen: Annotation<string | undefined>({
    value: (_: string | undefined, update: string | undefined) => update,
    default: () => undefined,
  }),

  /** Signal that the current tick should halt and await user input */
  __needsUserInput: Annotation<boolean | undefined>({
    value: (_: boolean | undefined, update: boolean | undefined) => update,
    default: () => undefined,
  }),

  /** When SlotTracker is awaiting a user reply, record which slot we're waiting on */
  awaitingInputFor: Annotation<string | undefined>({
    value: (_: string | undefined, update: string | undefined) => update,
    default: () => undefined,
  }),

  /** Monotonic cursor that increments whenever we consume a userPrompt */
  inputCursor: Annotation<number>({
    value: (_: number, update: number | undefined) => (typeof update === "number" ? update : _ ?? 0),
    default: () => 0,
  }),

  /** Optional: emitted by VectorSearch to hint prompt-engine that RAG context exists */
  contextMeta: Annotation<{
    count: number;
    combinedTextLength: number;
  } | undefined>({
    value: (_: { count: number; combinedTextLength: number } | undefined, update: { count: number; combinedTextLength: number } | undefined) => update,
    default: () => undefined,
  }),

  /** Data passed between nodes via template interpolation (e.g., {{input}}) */
  input: Annotation<Record<string, unknown> | undefined>({
    value: (_: Record<string, unknown> | undefined, update: Record<string, unknown> | undefined) => update,
    default: () => undefined,
  }),
});

export type State = typeof GraphState.State;