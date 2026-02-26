// amplify/functions/workflow-runner/src/prompt/memory.ts
import type { Schema } from "../../../../data/resource";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "PromptEngine.Memory" });

export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

/**
 * Fetch conversation memory from database
 * 
 * @param dataClient - Amplify data client
 * @param conversationId - ID of conversation to fetch memory for
 * @param memorySize - Maximum number of memory entries to retrieve
 * @param workflowId - Optional workflow ID for auto-creating missing conversations
 * @returns Promise<Array> - Array of memory segments sorted by timestamp
 */
export async function fetchConversationMemory(
  dataClient: DataClient,
  conversationId: string,
  memorySize: number,
  workflowId?: string
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  logger.info("Fetching conversation memory", {
    conversationId,
    memorySize
  });

  try {
    // Get conversation record
    let conversationResult = await dataClient.models.Conversation.get({ 
      id: conversationId 
    });
    
    if (!conversationResult.data) {
      logger.warn("Conversation not found", { conversationId });
      // If workflowId provided, auto-create to ensure future turns have memory continuity
      if (workflowId) {
        const createRes = await dataClient.models.Conversation.create({
          id: conversationId,
          workflowId,
          status: "ACTIVE",
        });
        if (!createRes.data) {
          logger.error("Failed to auto-create Conversation in fetchConversationMemory", {
            conversationId,
            workflowId,
          });
          return [];
        }
        // Re-fetch to acquire model instance with .memories()
        conversationResult = await dataClient.models.Conversation.get({ id: conversationId });
      } else {
        // No workflowId available → graceful fallback (first turn still streams; no memory yet)
        return [];
      }
    }

    // Fetch memories for this conversation
    const memoriesResult = await conversationResult.data!.memories();
    
    if (!memoriesResult.data || memoriesResult.data.length === 0) {
      logger.info("No memories found for conversation", { conversationId });
      return [];
    }

    // Filter, sort, and limit memories
    const processedMemories = memoriesResult.data
      // Only include user and assistant messages
      .filter(item => item.role === "user" || item.role === "assistant")
      // Sort by timestamp (oldest first)
      .sort((a, b) => {
        const timestampA = new Date(a.timestamp || "").getTime();
        const timestampB = new Date(b.timestamp || "").getTime();
        return timestampA - timestampB;
      })
      // Take the most recent N entries
      .slice(-memorySize)
      // Transform to our canonical format
      .map(item => ({
        role: item.role as "user" | "assistant",
        content: String(item.content ?? "")
      }))
      // Filter out empty content
      .filter(item => item.content.trim().length > 0);

    logger.info("Memory fetched successfully", {
      conversationId,
      totalMemories: memoriesResult.data.length,
      processedMemories: processedMemories.length,
      memorySize
    });

    return processedMemories;

  } catch (error) {
    logger.error("Failed to fetch conversation memory", {
      error: error instanceof Error ? error.message : "Unknown error",
      conversationId,
      memorySize
    });
    
    // Re-throw to allow caller to handle gracefully
    throw new Error(`Failed to fetch memory for conversation ${conversationId}: ${
      error instanceof Error ? error.message : "Unknown error"
    }`);
  }
}