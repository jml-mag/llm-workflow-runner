// amplify/functions/workflow-runner/src/prompt-engine/managers/MemoryManager.ts

import { Logger } from "@aws-lambda-powertools/logger";
import type { DataClient, MemorySegment } from "../types";

const logger = new Logger({ serviceName: "PromptEngine.MemoryManager" });

export class MemoryManager {
  private cache = new Map<string, CachedMemory>();
  private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes

  /**
   * Load conversation memory from database with caching and error handling
   */
  async loadConversationMemory(
    dataClient: DataClient,
    conversationId: string,
    memorySize: number = 10
  ): Promise<MemorySegment[]> {
    const startTime = Date.now();

    logger.info("Loading conversation memory", {
      conversationId,
      memorySize
    });

    // Check cache first
    const cacheKey = `${conversationId}:${memorySize}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      logger.debug("Memory cache hit", {
        conversationId,
        cacheAge: Date.now() - cached.cachedAt
      });
      return cached.memories;
    }

    try {
      // Fetch from database
      const memories = await this.fetchMemoriesFromDatabase(
        dataClient, 
        conversationId, 
        memorySize
      );

      // Update cache
      this.cache.set(cacheKey, {
        memories,
        cachedAt: Date.now()
      });

      // Clean old cache entries
      this.cleanCache();

      const loadTime = Date.now() - startTime;
      logger.info("Memory loaded successfully", {
        conversationId,
        memoryCount: memories.length,
        loadTime,
        cacheUpdated: true
      });

      return memories;

    } catch (error) {
      const loadTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      logger.error("Failed to load conversation memory", {
        error: errorMessage,
        conversationId,
        memorySize,
        loadTime
      });

      // Return empty array on error - don't fail the entire prompt build
      return [];
    }
  }

  /**
   * Fetch memories from database with proper error handling
   */
  private async fetchMemoriesFromDatabase(
    dataClient: DataClient,
    conversationId: string,
    memorySize: number
  ): Promise<MemorySegment[]> {
    try {
      // Get conversation record
      const conversationResult = await dataClient.models.Conversation.get({ 
        id: conversationId 
      });
      
      if (!conversationResult.data) {
        logger.warn("Conversation not found", { conversationId });
        return [];
      }

      // Fetch memories for this conversation
      const memoriesResult = await conversationResult.data.memories();
      
      if (!memoriesResult.data || memoriesResult.data.length === 0) {
        logger.info("No memories found for conversation", { conversationId });
        return [];
      }

      // Process and filter memories
      const processedMemories = this.processMemories(memoriesResult.data, memorySize);

      logger.debug("Raw memories processed", {
        conversationId,
        rawCount: memoriesResult.data.length,
        processedCount: processedMemories.length,
        memorySize
      });

      return processedMemories;

    } catch (error) {
      logger.error("Database memory fetch failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        conversationId,
        memorySize
      });
      throw error;
    }
  }

  /**
   * Process raw memory data into clean MemorySegments
   */
  private processMemories(rawMemories: unknown[], memorySize: number): MemorySegment[] {
    return rawMemories
      // Filter to only user and assistant messages
      .filter(item => {
        const memoryItem = item as { role?: string };
        return memoryItem.role === "user" || memoryItem.role === "assistant";
      })
      // Sort by timestamp (oldest first)
      .sort((a, b) => {
        const itemA = a as { timestamp?: string };
        const itemB = b as { timestamp?: string };
        const timestampA = new Date(itemA.timestamp || "").getTime();
        const timestampB = new Date(itemB.timestamp || "").getTime();
        return timestampA - timestampB;
      })
      // Take the most recent N entries
      .slice(-memorySize)
      // Transform to MemorySegment format
      .map(item => {
        const memoryItem = item as { role: string; content?: string; timestamp?: string };
        return {
          role: memoryItem.role as "user" | "assistant",
          content: this.sanitizeContent(String(memoryItem.content ?? "")),
          timestamp: memoryItem.timestamp
        };
      })
      // Filter out empty content
      .filter(item => item.content.trim().length > 0);
  }

  /**
   * Sanitize memory content for safety
   */
  private sanitizeContent(content: string): string {
    if (!content) return "";

    return content
      .trim()
      // Remove potential HTML/script content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[removed]')
      .replace(/<!--.*?-->/g, '')
      // Limit excessive whitespace
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{3,}/g, '  ');
  }

  /**
   * Validate memory segments for consistency
   */
  validateMemories(memories: MemorySegment[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    memories.forEach((memory, index) => {
      // Check role validity
      if (!memory.role || !["user", "assistant"].includes(memory.role)) {
        errors.push(`Invalid role at memory ${index}: ${memory.role}`);
      }

      // Check content
      if (!memory.content || memory.content.trim().length === 0) {
        warnings.push(`Empty content at memory ${index}`);
      }

      // Check for excessive size
      if (memory.content && memory.content.length > 10000) {
        warnings.push(`Very long memory content at ${index} (${memory.content.length} chars)`);
      }

      // Validate timestamp if present
      if (memory.timestamp) {
        const timestamp = new Date(memory.timestamp);
        if (isNaN(timestamp.getTime())) {
          warnings.push(`Invalid timestamp at memory ${index}: ${memory.timestamp}`);
        }
      }
    });

    // Check for conversation flow issues
    if (memories.length > 1) {
      for (let i = 1; i < memories.length; i++) {
        if (memories[i].role === memories[i-1].role) {
          warnings.push(`Consecutive ${memories[i].role} messages at positions ${i-1} and ${i}`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get memory statistics for debugging
   */
  getMemoryStats(memories: MemorySegment[]): MemoryStats {
    const totalMemories = memories.length;
    const userMessages = memories.filter(m => m.role === "user").length;
    const assistantMessages = memories.filter(m => m.role === "assistant").length;
    const totalCharacters = memories.reduce((sum, m) => sum + m.content.length, 0);
    const averageLength = totalMemories > 0 ? Math.round(totalCharacters / totalMemories) : 0;

    // Find oldest and newest messages
    const sortedByTime = memories
      .filter(m => m.timestamp)
      .sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime());

    const oldestTimestamp = sortedByTime.length > 0 ? sortedByTime[0].timestamp : undefined;
    const newestTimestamp = sortedByTime.length > 0 ? sortedByTime[sortedByTime.length - 1].timestamp : undefined;

    return {
      totalMemories,
      userMessages,
      assistantMessages,
      totalCharacters,
      averageLength,
      oldestTimestamp,
      newestTimestamp,
      memoryTimespan: oldestTimestamp && newestTimestamp ? 
        new Date(newestTimestamp).getTime() - new Date(oldestTimestamp).getTime() : 0
    };
  }

  /**
   * Clear memory cache (useful for testing or manual cache invalidation)
   */
  clearCache(): void {
    this.cache.clear();
    logger.info("Memory cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    const entries = Array.from(this.cache.values());
    const validEntries = entries.filter(entry => this.isCacheValid(entry));
    
    return {
      totalEntries: entries.length,
      validEntries: validEntries.length,
      oldestEntry: entries.length > 0 ? Math.min(...entries.map(e => e.cachedAt)) : 0,
      newestEntry: entries.length > 0 ? Math.max(...entries.map(e => e.cachedAt)) : 0
    };
  }

  /**
   * Check if cached memory is still valid
   */
  private isCacheValid(cached: CachedMemory): boolean {
    return Date.now() - cached.cachedAt < this.CACHE_TTL;
  }

  /**
   * Clean expired entries from cache
   */
  private cleanCache(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.cachedAt > this.CACHE_TTL) {
        this.cache.delete(key);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug("Cache cleanup completed", { 
        removedEntries: removedCount,
        remainingEntries: this.cache.size
      });
    }
  }
}

// Supporting interfaces
interface CachedMemory {
  memories: MemorySegment[];
  cachedAt: number;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

interface MemoryStats {
  totalMemories: number;
  userMessages: number;
  assistantMessages: number;
  totalCharacters: number;
  averageLength: number;
  oldestTimestamp?: string;
  newestTimestamp?: string;
  memoryTimespan: number; // milliseconds
}

interface CacheStats {
  totalEntries: number;
  validEntries: number;
  oldestEntry: number;
  newestEntry: number;
}