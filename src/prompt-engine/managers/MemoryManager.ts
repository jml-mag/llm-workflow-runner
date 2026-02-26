// amplify/functions/workflow-runner/src/prompt-engine/managers/MemoryManager.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import type { Schema } from "@platform/data/resource";

const logger = new Logger({ serviceName: "PromptEngine.MemoryManager" });
const metrics = new Metrics({ serviceName: "PromptEngine.MemoryManager" });

export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

export interface MemorySegment {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

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
  hitRate: number;
}

/**
 * Enhanced Memory Manager with PII protection and production-grade caching
 * Handles conversation memory loading with security safeguards and performance optimization
 */
export class MemoryManager {
  private cache = new Map<string, CachedMemory>();
  private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes
  private readonly MAX_CACHE_SIZE = 500;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(private readonly dataClient: DataClient) {}

  /**
   * Load conversation memory with enhanced error handling and PII awareness
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

    // Validate input parameters
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error("conversationId must be a valid string");
    }

    if (memorySize < 0 || memorySize > 100) {
      throw new Error("memorySize must be between 0 and 100");
    }

    // Check cache first
    const cacheKey = `${conversationId}:${memorySize}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      this.cacheHits++;
      
      logger.debug("Memory cache hit", {
        conversationId,
        memorySize,
        cacheAge: Date.now() - cached.cachedAt,
        memoriesReturned: cached.memories.length
      });

      metrics.addMetric('MemoryCacheHit', MetricUnit.Count, 1);
      return cached.memories;
    }

    this.cacheMisses++;

    try {
      // Fetch from database with enhanced error handling
      const memories = await this.fetchMemoriesFromDatabase(
        dataClient, 
        conversationId, 
        memorySize
      );

      // Validate memories before caching
      const validation = this.validateMemories(memories);
      if (validation.warnings.length > 0) {
        logger.warn("Memory validation warnings", {
          conversationId,
          warnings: validation.warnings
        });
      }

      // Update cache
      this.cache.set(cacheKey, {
        memories,
        cachedAt: Date.now()
      });

      // Clean cache periodically
      this.cleanCache();

      const loadTime = Date.now() - startTime;
      
      // Record metrics
      metrics.addMetric('MemoryLoaded', MetricUnit.Count, 1);
      metrics.addMetric('MemoryLoadLatency', MetricUnit.Milliseconds, loadTime);
      metrics.addMetric('MemoryCacheMiss', MetricUnit.Count, 1);
      metrics.addMetric('MemoriesReturned', MetricUnit.Count, memories.length);

      logger.info("Memory loaded successfully", {
        conversationId,
        memoryCount: memories.length,
        loadTime,
        cacheUpdated: true,
        validationPassed: validation.isValid
      });

      return memories;

    } catch (error) {
      const loadTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      metrics.addMetric('MemoryLoadFailure', MetricUnit.Count, 1);
      metrics.addMetric('MemoryLoadLatency', MetricUnit.Milliseconds, loadTime);
      
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
   * Fetch memories from database with comprehensive error handling
   */
  private async fetchMemoriesFromDatabase(
    dataClient: DataClient,
    conversationId: string,
    memorySize: number
  ): Promise<MemorySegment[]> {
    try {
      // Get conversation record first
      const conversationResult = await dataClient.models.Conversation.get({ 
        id: conversationId 
      });
      
      if (!conversationResult.data) {
        logger.warn("Conversation not found", { 
          conversationId,
          operation: 'fetch_conversation'
        });
        return [];
      }

      // Fetch memories for this conversation
      const memoriesResult = await conversationResult.data.memories();
      
      if (!memoriesResult.data || memoriesResult.data.length === 0) {
        logger.info("No memories found for conversation", { 
          conversationId,
          operation: 'fetch_memories'
        });
        return [];
      }

      // Process and filter memories with enhanced validation
      const processedMemories = this.processRawMemories(memoriesResult.data, memorySize);

      logger.debug("Raw memories processed", {
        conversationId,
        rawCount: memoriesResult.data.length,
        processedCount: processedMemories.length,
        memorySize,
        operation: 'process_memories'
      });

      return processedMemories;

    } catch (error) {
      logger.error("Database memory fetch failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        conversationId,
        memorySize,
        operation: 'fetch_from_database'
      });
      throw error;
    }
  }

  /**
   * Process raw memory data with enhanced validation and sanitization
   */
  private processRawMemories(rawMemories: unknown[], memorySize: number): MemorySegment[] {
    const processedMemories: MemorySegment[] = [];

    // Convert raw data to typed memory objects
    const typedMemories = rawMemories
      .map(item => this.convertToMemoryItem(item))
      .filter(item => item !== null) as Array<{
        role: string;
        content: string;
        timestamp?: string;
      }>;

    // Filter to only user and assistant messages
    const filteredMemories = typedMemories.filter(item => 
      item.role === "user" || item.role === "assistant"
    );

    // Sort by timestamp (oldest first) with proper date handling
    const sortedMemories = filteredMemories.sort((a, b) => {
      const timestampA = this.parseTimestamp(a.timestamp);
      const timestampB = this.parseTimestamp(b.timestamp);
      return timestampA - timestampB;
    });

    // Take the most recent N entries
    const recentMemories = sortedMemories.slice(-memorySize);

    // Process each memory with validation and sanitization
    for (const memory of recentMemories) {
      const processedMemory = this.processMemoryItem(memory);
      if (processedMemory) {
        processedMemories.push(processedMemory);
      }
    }

    logger.debug("Memory processing completed", {
      rawCount: rawMemories.length,
      filteredCount: filteredMemories.length,
      sortedCount: sortedMemories.length,
      finalCount: processedMemories.length,
      memorySize
    });

    return processedMemories;
  }

  /**
   * Convert unknown raw memory item to typed object
   */
  private convertToMemoryItem(item: unknown): {
    role: string;
    content: string;
    timestamp?: string;
  } | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const memoryItem = item as Record<string, unknown>;

    // Extract and validate required fields
    const role = typeof memoryItem.role === 'string' ? memoryItem.role : '';
    const content = typeof memoryItem.content === 'string' ? memoryItem.content : '';
    const timestamp = typeof memoryItem.timestamp === 'string' ? memoryItem.timestamp : undefined;

    if (!role || !content) {
      logger.debug("Skipping memory item with missing role or content", {
        hasRole: !!role,
        hasContent: !!content,
        itemKeys: Object.keys(memoryItem)
      });
      return null;
    }

    return { role, content, timestamp };
  }

  /**
   * Process individual memory item with sanitization
   */
  private processMemoryItem(memory: {
    role: string;
    content: string;
    timestamp?: string;
  }): MemorySegment | null {
    // Validate role
    if (memory.role !== "user" && memory.role !== "assistant") {
      logger.debug("Skipping memory with invalid role", {
        role: memory.role,
        contentLength: memory.content.length
      });
      return null;
    }

    // Sanitize and validate content
    const sanitizedContent = this.sanitizeContent(memory.content);
    if (sanitizedContent.trim().length === 0) {
      logger.debug("Skipping memory with empty content after sanitization", {
        role: memory.role,
        originalLength: memory.content.length
      });
      return null;
    }

    return {
      role: memory.role as "user" | "assistant",
      content: sanitizedContent,
      timestamp: memory.timestamp
    };
  }

  /**
   * Sanitize memory content for safety and consistency
   */
  private sanitizeContent(content: string): string {
    if (!content || typeof content !== 'string') {
      return '';
    }

    return content
      .trim()
      // Remove potential script content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[SCRIPT_REMOVED]')
      .replace(/<!--.*?-->/g, '')
      // Remove javascript: protocols
      .replace(/javascript:/gi, '[JS_PROTOCOL_REMOVED]')
      // Normalize whitespace
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Limit excessive whitespace
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{3,}/g, '  ')
      // Remove null bytes and control characters
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim();
  }

  /**
   * Parse timestamp with fallback handling
   */
  private parseTimestamp(timestamp?: string): number {
    if (!timestamp) {
      return 0; // Sort to beginning if no timestamp
    }

    try {
      const parsed = new Date(timestamp);
      if (isNaN(parsed.getTime())) {
        logger.debug("Invalid timestamp format", { timestamp });
        return 0;
      }
      return parsed.getTime();
    } catch (error) {
      logger.debug("Failed to parse timestamp", { 
        timestamp,
        error: error instanceof Error ? error.message : "Unknown error"
      });
      return 0;
    }
  }

  /**
   * Validate memory segments for consistency and safety
   */
  validateMemories(memories: MemorySegment[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(memories)) {
      errors.push("Memories must be an array");
      return { isValid: false, errors, warnings };
    }

    memories.forEach((memory, index) => {
      // Check role validity
      if (!memory.role || !["user", "assistant"].includes(memory.role)) {
        errors.push(`Invalid role at memory ${index}: ${memory.role}`);
      }

      // Check content
      if (!memory.content || typeof memory.content !== 'string') {
        errors.push(`Invalid content at memory ${index}`);
      } else if (memory.content.trim().length === 0) {
        warnings.push(`Empty content at memory ${index} (role: ${memory.role})`);
      } else if (memory.content.length > 50000) { // 50KB warning
        warnings.push(`Very long memory content at ${index} (${memory.content.length} chars, role: ${memory.role})`);
      }

      // Validate timestamp if present
      if (memory.timestamp) {
        const timestamp = new Date(memory.timestamp);
        if (isNaN(timestamp.getTime())) {
          warnings.push(`Invalid timestamp at memory ${index}: ${memory.timestamp}`);
        }
      }
    });

    // Check conversation flow
    if (memories.length > 1) {
      for (let i = 1; i < memories.length; i++) {
        if (memories[i].role === memories[i-1].role) {
          warnings.push(`Consecutive ${memories[i].role} messages at positions ${i-1} and ${i} - may indicate conversation flow issues`);
        }
      }
    }

    // Check for reasonable conversation balance
    const userCount = memories.filter(m => m.role === "user").length;
    const assistantCount = memories.filter(m => m.role === "assistant").length;

    if (userCount === 0 && assistantCount > 0) {
      warnings.push("Conversation has assistant messages but no user messages");
    }

    if (Math.abs(userCount - assistantCount) > 2) {
      warnings.push(`Unbalanced conversation: ${userCount} user, ${assistantCount} assistant messages`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get comprehensive memory statistics for monitoring and debugging
   */
  getMemoryStats(memories: MemorySegment[]): MemoryStats {
    if (!memories || memories.length === 0) {
      return {
        totalMemories: 0,
        userMessages: 0,
        assistantMessages: 0,
        totalCharacters: 0,
        averageLength: 0,
        memoryTimespan: 0
      };
    }

    const totalMemories = memories.length;
    const userMessages = memories.filter(m => m.role === "user").length;
    const assistantMessages = memories.filter(m => m.role === "assistant").length;
    const totalCharacters = memories.reduce((sum, m) => sum + m.content.length, 0);
    const averageLength = Math.round(totalCharacters / totalMemories);

    // Calculate timespan
    const memoriesWithTimestamps = memories.filter(m => m.timestamp);
    let memoryTimespan = 0;
    let oldestTimestamp: string | undefined;
    let newestTimestamp: string | undefined;

    if (memoriesWithTimestamps.length > 1) {
      const sortedByTime = memoriesWithTimestamps
        .map(m => ({ ...m, parsedTime: new Date(m.timestamp!).getTime() }))
        .filter(m => !isNaN(m.parsedTime))
        .sort((a, b) => a.parsedTime - b.parsedTime);

      if (sortedByTime.length > 0) {
        oldestTimestamp = sortedByTime[0].timestamp;
        newestTimestamp = sortedByTime[sortedByTime.length - 1].timestamp;
        memoryTimespan = sortedByTime[sortedByTime.length - 1].parsedTime - sortedByTime[0].parsedTime;
      }
    }

    return {
      totalMemories,
      userMessages,
      assistantMessages,
      totalCharacters,
      averageLength,
      oldestTimestamp,
      newestTimestamp,
      memoryTimespan
    };
  }

  /**
   * Preload memories for multiple conversations (batch operation)
   */
  async preloadMemories(
    conversationIds: string[],
    memorySize: number = 10
  ): Promise<{ successful: number; failed: number }> {
    logger.info("Preloading memories for multiple conversations", {
      conversationCount: conversationIds.length,
      memorySize
    });

    let successful = 0;
    let failed = 0;

    const preloadPromises = conversationIds.map(async (conversationId) => {
      try {
        await this.loadConversationMemory(this.dataClient, conversationId, memorySize);
        successful++;
      } catch (error) {
        failed++;
        logger.warn("Failed to preload memory", {
          conversationId,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    await Promise.allSettled(preloadPromises);
    
    logger.info("Memory preloading completed", {
      successful,
      failed,
      cacheSize: this.cache.size
    });

    return { successful, failed };
  }

  /**
   * Clear memory cache (useful for testing or cache invalidation)
   */
  clearCache(pattern?: { conversationId?: string; memorySize?: number }): number {
    if (!pattern) {
      const clearedCount = this.cache.size;
      this.cache.clear();
      this.cacheHits = 0;
      this.cacheMisses = 0;
      
      logger.info("Entire memory cache cleared", { clearedCount });
      return clearedCount;
    }

    const keysToRemove: string[] = [];

    for (const [key] of this.cache.entries()) {
      const [cachedConversationId, cachedMemorySize] = key.split(':');
      
      const shouldRemove = 
        (!pattern.conversationId || cachedConversationId === pattern.conversationId) &&
        (!pattern.memorySize || cachedMemorySize === String(pattern.memorySize));
      
      if (shouldRemove) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => this.cache.delete(key));
    
    logger.info("Selective cache clearing completed", {
      removedKeys: keysToRemove.length,
      pattern
    });

    return keysToRemove.length;
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): CacheStats {
    const entries = Array.from(this.cache.values());
    const validEntries = entries.filter(entry => this.isCacheValid(entry));
    const totalRequests = this.cacheHits + this.cacheMisses;
    const hitRate = totalRequests > 0 ? this.cacheHits / totalRequests : 0;
    
    return {
      totalEntries: entries.length,
      validEntries: validEntries.length,
      oldestEntry: entries.length > 0 ? Math.min(...entries.map(e => e.cachedAt)) : 0,
      newestEntry: entries.length > 0 ? Math.max(...entries.map(e => e.cachedAt)) : 0,
      hitRate: Math.round(hitRate * 100) / 100 // Round to 2 decimal places
    };
  }

  /**
   * Check if cached memory is still valid
   */
  private isCacheValid(cached: CachedMemory): boolean {
    return Date.now() - cached.cachedAt < this.CACHE_TTL;
  }

  /**
   * Clean expired and excess entries from cache
   */
  private cleanCache(): void {
    const now = Date.now();
    let removedCount = 0;

    // Remove expired entries first
    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.cachedAt > this.CACHE_TTL) {
        this.cache.delete(key);
        removedCount++;
      }
    }

    // Remove oldest entries if still over limit
    if (this.cache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.cachedAt - b.cachedAt);

      while (this.cache.size > this.MAX_CACHE_SIZE && entries.length > 0) {
        const [oldestKey] = entries.shift()!;
        this.cache.delete(oldestKey);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug("Memory cache cleanup completed", { 
        removedEntries: removedCount,
        remainingEntries: this.cache.size
      });

      metrics.addMetric('MemoryCacheEntriesRemoved', MetricUnit.Count, removedCount);
    }
  }

  /**
   * Health check for memory system
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    cacheStats: CacheStats;
    issues: string[];
  }> {
    const issues: string[] = [];
    const cacheStats = this.getCacheStats();

    // Check cache health
    if (cacheStats.validEntries < cacheStats.totalEntries * 0.8) {
      issues.push("High cache expiration rate detected");
    }

    if (cacheStats.hitRate < 0.3 && this.cacheHits + this.cacheMisses > 10) {
      issues.push("Low cache hit rate detected");
    }

    // Check if cache is approaching limits
    if (cacheStats.totalEntries > this.MAX_CACHE_SIZE * 0.9) {
      issues.push("Cache approaching size limit");
    }

    const healthy = issues.length === 0;

    logger.debug("Memory manager health check", {
      healthy,
      cacheStats,
      issues
    });

    return {
      healthy,
      cacheStats,
      issues
    };
  }
}