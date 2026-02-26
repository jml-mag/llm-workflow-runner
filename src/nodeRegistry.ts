// amplify/functions/workflow-runner/src/nodeRegistry.ts

import { handleConversationMemory } from "./nodes/ConversationMemory";
import { handleModelInvoke } from "./nodes/ModelInvoke";  // ✅ SINGLE: Enhanced version uses EnhancedLLMService internally
import { handleFormat } from "./nodes/Format";
import { handleStreamToClient } from "./nodes/StreamToClient";
import { handleRouter } from "./nodes/Router";
import { handleVectorSearch } from "./nodes/VectorSearch";
import { handleVectorWrite } from "./nodes/VectorWrite";

// ===== NEW NODE IMPORTS =====
import { handleSlotTracker } from "./nodes/SlotTracker";
import { handleIntentClassifier } from "./nodes/IntentClassifier";

// ✅ REMOVED: All references to EnhancedModelInvoke - consolidated into ModelInvoke

import type { State } from "./types";

// ✅ FIXED: Use correct relative path
import type { Schema } from "@platform/data/resource";

// ✅ Use proper Amplify data client type with Schema
type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// Strictly typed node handler function signature
type NodeHandler = (state: State, dataClient: DataClient) => Promise<Partial<State>>;

// Wrapper function to create data client-aware handlers with strict typing
const createDataClientHandler = (handler: NodeHandler): NodeHandler => {
  return (state: State, dataClient: DataClient): Promise<Partial<State>> => 
    handler(state, dataClient);
};

// Strictly typed registry with proper node handler mapping
export const nodeRegistry: Record<string, NodeHandler> = {
  // ===== SEMANTIC NODE TYPE NAMES =====
  // (match what's used in workflow definitions)
  
  ConversationMemory: createDataClientHandler(handleConversationMemory),
  ModelInvoke: createDataClientHandler(handleModelInvoke),         // ✅ CANONICAL: Enhanced internally
  Format: createDataClientHandler(handleFormat),
  StreamToClient: createDataClientHandler(handleStreamToClient),
  Router: createDataClientHandler(handleRouter),                   // Enhanced version
  VectorSearch: createDataClientHandler(handleVectorSearch),
  VectorWrite: createDataClientHandler(handleVectorWrite),
  
  // ===== NEW NODES =====
  SlotTracker: createDataClientHandler(handleSlotTracker),
  IntentClassifier: createDataClientHandler(handleIntentClassifier),
     
  // ===== ALTERNATIVE MAPPINGS =====
  // (for different workflow naming conventions)
  
  ai_model: createDataClientHandler(handleModelInvoke),             // Maps to canonical ModelInvoke
  stream_to_client: createDataClientHandler(handleStreamToClient), // Maps to existing StreamToClient
  conversation_memory: createDataClientHandler(handleConversationMemory),
  format: createDataClientHandler(handleFormat),
  router: createDataClientHandler(handleRouter),                   // Enhanced router
  vector_search: createDataClientHandler(handleVectorSearch),      // Vector search mapping
  vector_write: createDataClientHandler(handleVectorWrite),        // Vector write mapping
  
  // ===== NEW NODE ALTERNATIVE MAPPINGS =====
  slot_tracker: createDataClientHandler(handleSlotTracker),        // Snake case alternative
  intent_classifier: createDataClientHandler(handleIntentClassifier), // Snake case alternative
  
  // ✅ CRITICAL FIX: Add the missing document_search mapping
  document_search: createDataClientHandler(handleVectorSearch),    // Frontend builderV2 compatibility
};