// amplify/functions/workflow-runner/src/nodes/VectorSearch.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

import type { State, NodeConfig } from "../types";
import type { Schema } from "../../../../data/resource";
import { PineconeService } from "../services/pineconeService";
import { loadSettings } from "../../../shared/settingsClient";
import { logProgressForOwners } from "../utils/progress";

// Ensure explicit service name to avoid 'service_undefined' logs
const logger = new Logger({ serviceName: 'VectorSearch' });
const tracer = new Tracer({ serviceName: 'VectorSearch' });
const metrics = new Metrics({ serviceName: 'VectorSearch' });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// Create shared PineconeService instance
const pineconeService = new PineconeService();

// Bedrock client for embeddings
const bedrockClient = tracer.captureAWSv3Client(
  new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" })
);

// Vector Search Node interfaces
interface VectorSearchConfig extends NodeConfig {
  searchQuery?: string;
  resultCount?: number;
  topK?: number;
}

/**
 * Vector Search Node
 * 
 * Accepts { query, topK, userId } → generates embedding with Titan V2 → 
 * searches Pinecone → returns { context, matches }
 * 
 * ✅ NEW: Supports collection filtering via allowedDocumentIds
 */
export const handleVectorSearch = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "VectorSearch");
  logger.info("Node: VectorSearch — starting vector search");

  // Early guard: if there is no workable query, skip search gracefully
  const q =
    (typeof state.input === "string" ? state.input : undefined) ??
    (state.input && typeof state.input === "object" && "searchQuery" in state.input
      ? String((state.input as Record<string, unknown>)["searchQuery"] ?? "")
      : "");

  if (!q || q.trim().length === 0) {
    // Optionally emit a small INFO event for transparency
    try {
      await dataClient.models.WorkflowProgress.create({
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        owner: state.userId,
        stepName: "Search",
        status: "INFO",
        message: "Skipped vector search (empty query)",
        metadata: JSON.stringify({ userVisible: false }),
        eventTime: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    return {
      // Keep state.input as-is so downstream planner can still run
    };
  }

  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "VectorSearch",
    status: "STARTED",
    message: "Searching your documents…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Search", 
        body: "Searching…" 
      } 
    })
  });

  // Initialize PineconeService
  await pineconeService.initialize();

  try {
    // Load settings for embedding dimensions
    const settings = await loadSettings();
    
    // Extract configuration
    const config = state.currentNodeConfig as VectorSearchConfig || {};
    const query = config.searchQuery || state.userPrompt || "";
    const topK = config.resultCount || config.topK || settings.topK || 10;
    
    // Get userId from state for namespace isolation
    const userId = state.userId;
    
    // ✅ NEW: Extract collection filtering from state
    const allowedDocumentIds = state.allowedDocumentIds && state.allowedDocumentIds.length > 0 
      ? state.allowedDocumentIds 
      : undefined;
    
    if (!query.trim()) {
      logger.warn("No search query provided");
      
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "VectorSearch",
        status: "COMPLETED",
        message: "No search query provided",
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Matches", 
            items: ["0"] 
          },
          queryProvided: false,
          fallbackBehavior: "empty_response"
        })
      });
      
      return {
        modelResponse: "No search query provided for vector search.",
        formattedResponse: "No search query provided for vector search."
      };
    }

    logger.info("VectorSearch configuration", {
      queryLength: query.length,
      topK,
      userId,
      embeddingDimension: settings.embeddingDimension,
      hasCollectionFilter: !!allowedDocumentIds,
      allowedDocumentCount: allowedDocumentIds?.length ?? 0
    });

    // Generate embedding using Titan V2
    const embeddingModelId = process.env.EMBEDDING_MODEL || "amazon.titan-embed-text-v2:0";
    
    logger.info("Generating embedding", {
      modelId: embeddingModelId,
      textLength: query.length,
      dimensions: settings.embeddingDimension
    });

    // ===== MEASURE EMBEDDING GENERATION TIME =====
    const embeddingStartTime = Date.now();
    
    const embeddingCommand = new InvokeModelCommand({
      modelId: embeddingModelId,
      body: JSON.stringify({
        inputText: query,
        dimensions: settings.embeddingDimension,
        normalize: true,
      }),
      contentType: "application/json",
    });

    const embeddingResponse = await bedrockClient.send(embeddingCommand);
    const embeddingData = JSON.parse(new TextDecoder().decode(embeddingResponse.body));
    const queryVector = embeddingData.embedding as number[];
    
    const embeddingGenerationTime = Date.now() - embeddingStartTime;

    logger.info("Embedding generated successfully", {
      vectorLength: queryVector.length,
      expectedDimension: settings.embeddingDimension,
      embeddingTime: embeddingGenerationTime
    });

    // Validate embedding dimensions
    if (queryVector.length !== settings.embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch: got ${queryVector.length}, expected ${settings.embeddingDimension}`
      );
    }

    // ✅ UPDATED: Search vectors in Pinecone with namespace isolation AND collection filtering
    logger.info("Searching vectors in Pinecone", { 
      topK, 
      namespace: userId,
      hasCollectionFilter: !!allowedDocumentIds,
      allowedDocumentCount: allowedDocumentIds?.length ?? 0
    });
    
    // ===== MEASURE PINECONE QUERY TIME =====
    const pineconeStartTime = Date.now();
    
    const searchResults = await pineconeService.queryVectors(
      queryVector,
      topK,
      userId, // Uses userId for namespace isolation
      undefined, // No additional metadata filter
      allowedDocumentIds // ✅ NEW: Collection filtering support
    );
    
    const pineconeQueryTime = Date.now() - pineconeStartTime;
    const totalSearchTime = embeddingGenerationTime + pineconeQueryTime;

    const matches = searchResults.matches.map(match => ({
      id: match.id,
      score: match.score || 0,
      metadata: match.metadata as Record<string, unknown> || {}
    }));

    // Build context string from search results
    const contextParts: string[] = [];
    
    matches.forEach((match, index) => {
      const text = match.metadata.text as string || match.metadata.content as string || "";
      const source = match.metadata.source as string || match.metadata.filename as string || `Document ${index + 1}`;
      
      if (text && text.trim()) {
        contextParts.push(`[${source}]\n${text.trim()}`);
      }
    });

    const context = contextParts.join("\n\n---\n\n");
    
    logger.info("Vector search completed", {
      matchCount: matches.length,
      contextLength: context.length,
      totalSearchTime,
      collectionFiltered: !!allowedDocumentIds,
      topMatch: matches.length > 0 ? {
        id: matches[0].id,
        score: matches[0].score
      } : null
    });

    // Store results for downstream nodes
    const updatedState: Partial<State> = {
      modelResponse: context, // Store context as model response for downstream nodes
      formattedResponse: context,
      // Store search results in memory for debugging/inspection
      memory: [
        ...state.memory,
        {
          role: "assistant" as const,
          content: `Found ${matches.length} relevant documents for query: "${query}"${allowedDocumentIds ? ` (filtered to ${allowedDocumentIds.length} allowed documents)` : ""}`
        }
      ],
      // Optional: provide context meta for prompt-engine routing
      contextMeta: {
        count: matches.length,
        combinedTextLength: context.length,
      },
    };

    // 4. Emit COMPLETED with clear message and structured metrics
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "VectorSearch",
      status: "COMPLETED",
      message: `Matches: ${matches.length}`,
      metadata: JSON.stringify({
        userVisible: true,
        ui: { 
          kind: "chips", 
          title: "Matches", 
          items: [String(matches.length)] 
        },
        // Structured metrics for telemetry
        matchCount: matches.length,
        contextLength: context.length,
        topK,
        namespace: userId,
        embeddingModel: embeddingModelId,
        queryLength: query.length,
        embeddingDimension: settings.embeddingDimension,
        topMatch: matches.length > 0 ? {
          id: matches[0].id,
          score: matches[0].score
        } : null,
        collectionFiltering: {
          enabled: !!allowedDocumentIds,
          allowedDocumentCount: allowedDocumentIds?.length ?? 0,
          filteredResults: !!allowedDocumentIds
        },
        searchPerformance: {
          embeddingGenerationTime,
          pineconeQueryTime,
          totalSearchTime
        },
        matchDetails: matches.slice(0, 3).map(match => ({
          id: match.id,
          score: match.score,
          hasText: !!(match.metadata.text || match.metadata.content),
          source: match.metadata.source || match.metadata.filename || "unknown"
        })),
        contextPreview: context.substring(0, 200) + (context.length > 200 ? "..." : ""),
        queryEmbeddingPreview: queryVector.slice(0, 5),
        searchSettings: {
          embeddingDimension: settings.embeddingDimension,
          normalize: true,
          topK: topK
        }
      })
    });

    metrics.addMetric("VectorSearches", MetricUnit.Count, 1);
    metrics.addMetric("VectorMatches", MetricUnit.Count, matches.length);
    metrics.addMetric("ContextLength", MetricUnit.Count, context.length);
    metrics.addMetric("EmbeddingGenerationTime", MetricUnit.Milliseconds, embeddingGenerationTime);
    metrics.addMetric("PineconeQueryTime", MetricUnit.Milliseconds, pineconeQueryTime);
    
    if (allowedDocumentIds) {
      metrics.addMetric("CollectionFilteredSearches", MetricUnit.Count, 1);
      metrics.addMetric("AllowedDocumentCount", MetricUnit.Count, allowedDocumentIds.length);
    }
    
    logger.info("VectorSearch node completed successfully", {
      contextPreview: context.substring(0, 200),
      matchCount: matches.length,
      totalSearchTime,
      collectionFiltered: !!allowedDocumentIds
    });

    return updatedState;

  } catch (error) {
    logger.error("VectorSearch failed", error as Error);
    
    const errorMessage = (error as Error).message;
    const userId = state.userId;
    const config = state.currentNodeConfig as VectorSearchConfig || {};
    const query = config.searchQuery || state.userPrompt || "";
    const topK = config.resultCount || config.topK || 10;
    const allowedDocumentIds = state.allowedDocumentIds && state.allowedDocumentIds.length > 0 
      ? state.allowedDocumentIds 
      : undefined;
    
    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "VectorSearch",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: (error as Error).stack,
        queryLength: query.length,
        topK: topK,
        userId: userId,
        embeddingModel: process.env.EMBEDDING_MODEL || "amazon.titan-embed-text-v2:0",
        collectionFiltering: {
          enabled: !!allowedDocumentIds,
          allowedDocumentCount: allowedDocumentIds?.length ?? 0
        }
      })
    });

    metrics.addMetric("VectorSearchErrors", MetricUnit.Count, 1);
    
    throw error;
  }
};