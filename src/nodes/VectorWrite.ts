// amplify/functions/workflow-runner/src/nodes/VectorWrite.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";

import type { State, NodeConfig } from "../types";
import type { Schema } from "@platform/data/resource";
import { PineconeService, type PineconeVector } from "../services/pineconeService";
import { logProgressForOwners } from "../utils/progress";

// Ensure explicit service name to avoid 'service_undefined' logs
const logger = new Logger({ serviceName: 'VectorWrite' });
const tracer = new Tracer({ serviceName: 'VectorWrite' });
const metrics = new Metrics({ serviceName: 'VectorWrite' });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// Create shared PineconeService instance
const pineconeService = new PineconeService();

// Vector Write Node interfaces
interface VectorWriteConfig extends NodeConfig {
  vectors?: Array<{
    id: string;
    values: number[];
    metadata: Record<string, string | number | boolean>;
  }>;
}

/**
 * Vector Write Node
 * 
 * Accepts { vectors: [{ id, values, metadata }], userId } → 
 * validates dimensions → upserts to Pinecone with namespace isolation →
 * returns { upsertedCount, vectorIds }
 */
export const handleVectorWrite = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "VectorWrite");
  logger.info("Node: VectorWrite — starting vector upsert");

  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "VectorWrite",
    status: "STARTED",
    message: "Indexing results…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Index", 
        body: "Writing vectors…" 
      } 
    })
  });

  // Initialize PineconeService
  await pineconeService.initialize();

  try {
    // Extract configuration
    const config = state.currentNodeConfig as VectorWriteConfig || {};
    
    // Get userId from state for namespace isolation
    const userId = state.userId;
    
    // Extract vectors from config or state
    let vectors: PineconeVector[] = [];
    
    if (config.vectors && Array.isArray(config.vectors)) {
      vectors = config.vectors as PineconeVector[];
    } else {
      // If no vectors in config, this might be a memory storage operation
      const memoryText = state.modelResponse || state.userPrompt || "";
      
      if (!memoryText.trim()) {
        logger.warn("No vectors provided and no text content to vectorize");
        
        const message = "No vectors provided for storage.";
        
        await logProgressForOwners(dataClient, owners, {
          workflowId: state.workflowId,
          conversationId: state.conversationId,
          stepName: "VectorWrite",
          status: "COMPLETED",
          message: "Indexed: 0",
          metadata: JSON.stringify({
            userVisible: true,
            ui: { 
              kind: "chips", 
              title: "Indexed", 
              items: ["0"] 
            },
            reason: "no_vectors_or_content",
            hasConfig: !!config.vectors,
            hasMemoryText: !!memoryText.trim(),
            userId
          })
        });
        
        return {
          modelResponse: message,
          formattedResponse: message
        };
      }

      // For memory storage, we'd need to generate embeddings here
      logger.info("Memory storage mode - would generate embeddings from text", {
        textLength: memoryText.length,
        userId
      });
      
      const message = "Memory storage functionality requires embedding generation (not implemented in this node)";
      
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "VectorWrite",
        status: "COMPLETED",
        message: "Indexed: 0",
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Indexed", 
            items: ["0"] 
          },
          reason: "embedding_generation_needed",
          textLength: memoryText.length,
          userId,
          memoryTextPreview: memoryText.substring(0, 100)
        })
      });
      
      return {
        modelResponse: message,
        formattedResponse: message
      };
    }

    if (!vectors || vectors.length === 0) {
      logger.warn("No vectors provided for upsert");
      const message = "No vectors provided for upsert operation";
      
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "VectorWrite",
        status: "COMPLETED",
        message: "Indexed: 0",
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Indexed", 
            items: ["0"] 
          },
          reason: "no_vectors",
          configProvided: !!config,
          userId
        })
      });
      
      return {
        modelResponse: message,
        formattedResponse: message
      };
    }

    logger.info("VectorWrite configuration", {
      vectorCount: vectors.length,
      userId,
      namespace: userId === 'system' ? 'system' : userId,
      sampleVectorId: vectors[0]?.id,
      sampleVectorDimension: vectors[0]?.values?.length
    });

    // 3. Do the work - validate and upsert vectors
    // Validate vectors before upserting
    const invalidVectors: string[] = [];
    
    for (const vector of vectors) {
      const validation = await pineconeService.validateVector(vector);
      if (!validation.isValid) {
        invalidVectors.push(`${vector.id}: ${validation.errors.join(", ")}`);
      }
    }

    if (invalidVectors.length > 0) {
      const errorMessage = `Invalid vectors detected: ${invalidVectors.join("; ")}`;
      logger.error("Vector validation failed", { invalidVectors });
      
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "VectorWrite",
        status: "ERROR",
        message: `Failed: ${invalidVectors.length} invalid vectors`,
        metadata: JSON.stringify({
          error: errorMessage,
          invalidVectorCount: invalidVectors.length,
          totalVectorCount: vectors.length,
          invalidVectors: invalidVectors.slice(0, 5), // Limit for size
          userId
        })
      });

      throw new Error(errorMessage);
    }

    // Upsert vectors to Pinecone with namespace isolation
    logger.info("Upserting vectors to Pinecone", { 
      vectorCount: vectors.length, 
      namespace: userId 
    });
    
    const upsertResult = await pineconeService.upsertVectors(vectors, userId);
    const namespace = userId === 'system' ? 'system' : userId;
    
    logger.info("Vector upsert completed", {
      upsertedCount: upsertResult.upsertedCount,
      vectorIds: upsertResult.vectorIds.slice(0, 5), // Log first 5 IDs
      namespace
    });

    // Store results in state for downstream nodes
    const message = `Successfully stored ${upsertResult.upsertedCount} vectors in ${namespace ? `namespace: ${namespace}` : 'global namespace'}`;
    const updatedState: Partial<State> = {
      modelResponse: message,
      formattedResponse: message,
      // Add to memory for debugging/inspection
      memory: [
        ...state.memory,
        {
          role: "assistant" as const,
          content: message
        }
      ]
    };

    // 4. Emit COMPLETED with item counts
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "VectorWrite",
      status: "COMPLETED",
      message: `Indexed: ${upsertResult.upsertedCount}`,
      metadata: JSON.stringify({
        userVisible: true,
        ui: { 
          kind: "chips", 
          title: "Indexed", 
          items: [String(upsertResult.upsertedCount)] 
        },
        // Structured metadata for telemetry
        upsertedCount: upsertResult.upsertedCount,
        vectorIds: upsertResult.vectorIds.slice(0, 5),
        namespace,
        originalVectorCount: vectors.length,
        userId,
        averageVectorDimension: vectors.length > 0 ? 
          Math.round(vectors.reduce((sum, v) => sum + v.values.length, 0) / vectors.length) : 0,
        sampleMetadata: vectors[0]?.metadata || {}
      })
    });

    metrics.addMetric("VectorWrites", MetricUnit.Count, 1);
    metrics.addMetric("VectorsUpserted", MetricUnit.Count, upsertResult.upsertedCount);
    
    logger.info("VectorWrite node completed successfully", {
      upsertedCount: upsertResult.upsertedCount,
      namespace
    });

    return updatedState;

  } catch (error) {
    logger.error("VectorWrite failed", error as Error);
    
    const errorMessage = (error as Error).message;
    const userId = state.userId;
    const config = state.currentNodeConfig as VectorWriteConfig || {};
    let vectors: PineconeVector[] = [];
    if (config.vectors && Array.isArray(config.vectors)) {
      vectors = config.vectors as PineconeVector[];
    }
    
    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "VectorWrite",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: (error as Error).stack,
        vectorCount: vectors.length,
        userId: userId,
        configProvided: !!state.currentNodeConfig,
        pineconeInitialized: true
      })
    });

    metrics.addMetric("VectorWriteErrors", MetricUnit.Count, 1);
    
    throw error;
  }
};