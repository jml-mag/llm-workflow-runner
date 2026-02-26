// amplify/functions/workflow-runner/src/prompt-engine/managers/BasePromptManager.ts

import { Logger } from "@aws-lambda-powertools/logger";
import type { DataClient, BasePrompt, CachedPrompt } from "../types";

const logger = new Logger({ serviceName: "PromptEngine.BasePromptManager" });

export class BasePromptManager {
  private cache = new Map<string, CachedPrompt>();
  private readonly TTL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 100;

  /**
   * Get base prompt with intelligent fallback strategy
   * Priority: workflow-specific -> model-specific -> default -> emergency
   */
  async getBasePrompt(
    dataClient: DataClient,
    workflowId: string,
    modelId: string
  ): Promise<BasePrompt> {
    const startTime = Date.now();

    logger.info("Loading base prompt", {
      workflowId,
      modelId
    });

    // Try multiple cache keys in priority order
    const cacheKeys = [
      `${workflowId}:${modelId}`, // Workflow + model specific
      `default:${modelId}`,       // Model specific default
      `default:default`           // Global default
    ];

    // Check cache for any matching key
    for (const cacheKey of cacheKeys) {
      const cached = this.cache.get(cacheKey);
      if (cached && this.isCacheValid(cached)) {
        logger.debug("Base prompt cache hit", {
          cacheKey,
          promptVersion: cached.prompt.version,
          cacheAge: Date.now() - cached.cachedAt
        });
        return cached.prompt;
      }
    }

    try {
      // Try to load from database in priority order
      let basePrompt = await this.loadWorkflowSpecificPrompt(dataClient, workflowId, modelId);
      
      if (!basePrompt) {
        basePrompt = await this.loadModelDefaultPrompt(dataClient, modelId);
      }
      
      if (!basePrompt) {
        basePrompt = await this.loadGlobalDefaultPrompt(dataClient);
      }
      
      if (!basePrompt) {
        basePrompt = this.getEmergencyFallbackPrompt(modelId);
        logger.warn("Using emergency fallback prompt", {
          workflowId,
          modelId,
          reason: "no_prompts_in_database"
        });
      }

      // Cache the result
      const cacheKey = basePrompt.workflowId ? 
        `${basePrompt.workflowId}:${basePrompt.modelId}` : 
        `default:${basePrompt.modelId}`;
      
      this.cache.set(cacheKey, {
        prompt: basePrompt,
        cachedAt: Date.now()
      });

      // Clean cache periodically
      this.cleanCache();

      const loadTime = Date.now() - startTime;
      logger.info("Base prompt loaded successfully", {
        promptId: basePrompt.id,
        version: basePrompt.version,
        workflowSpecific: !!basePrompt.workflowId,
        loadTime,
        contentLength: basePrompt.content.length
      });

      return basePrompt;

    } catch (error) {
      const loadTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      logger.error("Failed to load base prompt, using emergency fallback", {
        error: errorMessage,
        workflowId,
        modelId,
        loadTime
      });

      // Return emergency fallback - never fail completely
      return this.getEmergencyFallbackPrompt(modelId);
    }
  }

  /**
   * Load workflow-specific prompt
   */
  private async loadWorkflowSpecificPrompt(
    dataClient: DataClient,
    workflowId: string,
    modelId: string
  ): Promise<BasePrompt | null> {
    try {
      const result = await dataClient.models.BasePrompt.list({
        filter: {
          workflowId: { eq: workflowId },
          modelId: { eq: modelId },
          isActive: { eq: true }
        },
        limit: 1
      });

      if (result.data && result.data.length > 0) {
        const promptData = result.data[0];
        logger.debug("Found workflow-specific prompt", {
          promptId: promptData.id,
          workflowId,
          modelId,
          version: promptData.version
        });

        return {
          id: promptData.id,
          content: promptData.content,
          version: promptData.version,
          workflowId: promptData.workflowId || undefined,
          modelId: promptData.modelId,
          isActive: promptData.isActive ?? true // Handle null values
        };
      }

      return null;
    } catch (error) {
      logger.warn("Failed to load workflow-specific prompt", {
        error: error instanceof Error ? error.message : "Unknown error",
        workflowId,
        modelId
      });
      return null;
    }
  }

  /**
   * Load model-specific default prompt
   */
  private async loadModelDefaultPrompt(
    dataClient: DataClient,
    modelId: string
  ): Promise<BasePrompt | null> {
    try {
      const result = await dataClient.models.BasePrompt.list({
        filter: {
          modelId: { eq: modelId },
          isActive: { eq: true },
          workflowId: { attributeExists: false } // null workflow ID = default
        },
        limit: 1
      });

      if (result.data && result.data.length > 0) {
        const promptData = result.data[0];
        logger.debug("Found model-specific default prompt", {
          promptId: promptData.id,
          modelId,
          version: promptData.version
        });

        return {
          id: promptData.id,
          content: promptData.content,
          version: promptData.version,
          workflowId: undefined,
          modelId: promptData.modelId,
          isActive: promptData.isActive ?? true // Handle null values
        };
      }

      return null;
    } catch (error) {
      logger.warn("Failed to load model-specific default prompt", {
        error: error instanceof Error ? error.message : "Unknown error",
        modelId
      });
      return null;
    }
  }

  /**
   * Load global default prompt (last resort before emergency fallback)
   */
  private async loadGlobalDefaultPrompt(dataClient: DataClient): Promise<BasePrompt | null> {
    try {
      const result = await dataClient.models.BasePrompt.list({
        filter: {
          modelId: { eq: "default" },
          isActive: { eq: true },
          workflowId: { attributeExists: false }
        },
        limit: 1
      });

      if (result.data && result.data.length > 0) {
        const promptData = result.data[0];
        logger.debug("Found global default prompt", {
          promptId: promptData.id,
          version: promptData.version
        });

        return {
          id: promptData.id,
          content: promptData.content,
          version: promptData.version,
          workflowId: undefined,
          modelId: "default",
          isActive: promptData.isActive ?? true // Handle null values
        };
      }

      return null;
    } catch (error) {
      logger.warn("Failed to load global default prompt", {
        error: error instanceof Error ? error.message : "Unknown error"
      });
      return null;
    }
  }

  /**
   * Emergency fallback prompt - never fails
   */
  private getEmergencyFallbackPrompt(modelId: string): BasePrompt {
    const content = `You are a helpful AI assistant working within the Matter and Gas Platform workflow automation system.

## Core Principles
- Provide accurate, well-reasoned responses
- Maintain consistency with platform capabilities
- Adapt communication style to user expertise level
- Follow specified output formats precisely

## Response Guidelines
- Be concise yet comprehensive
- Use clear, professional language
- Handle errors gracefully with helpful alternatives
- Maintain context awareness across conversation turns

You are operating within an automated workflow system. Your responses directly influence workflow execution and user experience.`;

    return {
      id: "emergency-fallback",
      content,
      version: "emergency-v1.0.0",
      workflowId: undefined,
      modelId,
      isActive: true
    };
  }

  /**
   * Preload prompts into cache (useful for warming up)
   */
  async preloadPrompts(
    dataClient: DataClient,
    promptKeys: Array<{ workflowId?: string; modelId: string }>
  ): Promise<void> {
    logger.info("Preloading prompts into cache", {
      promptCount: promptKeys.length
    });

    const preloadPromises = promptKeys.map(async ({ workflowId, modelId }) => {
      try {
        await this.getBasePrompt(dataClient, workflowId || "default", modelId);
      } catch (error) {
        logger.warn("Failed to preload prompt", {
          workflowId,
          modelId,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    });

    await Promise.allSettled(preloadPromises);
    
    logger.info("Prompt preloading completed", {
      cacheSize: this.cache.size
    });
  }

  /**
   * Invalidate cache entries (useful when prompts are updated)
   */
  invalidateCache(workflowId?: string, modelId?: string): void {
    if (!workflowId && !modelId) {
      // Clear entire cache
      this.cache.clear();
      logger.info("Entire prompt cache cleared");
      return;
    }

    const keysToRemove: string[] = [];

    for (const [key] of this.cache.entries()) {
      const shouldRemove = 
        (!workflowId || key.includes(workflowId)) &&
        (!modelId || key.includes(modelId));
      
      if (shouldRemove) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => this.cache.delete(key));
    
    logger.info("Cache entries invalidated", {
      removedKeys: keysToRemove.length,
      workflowId,
      modelId
    });
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
      hitRate: 0, // Would need to track hits/misses over time
      oldestEntry: entries.length > 0 ? Math.min(...entries.map(e => e.cachedAt)) : 0,
      newestEntry: entries.length > 0 ? Math.max(...entries.map(e => e.cachedAt)) : 0,
      averageContentLength: validEntries.length > 0 ? 
        Math.round(validEntries.reduce((sum, e) => sum + e.prompt.content.length, 0) / validEntries.length) : 0
    };
  }

  /**
   * Check if cached prompt is still valid
   */
  private isCacheValid(cached: CachedPrompt): boolean {
    return Date.now() - cached.cachedAt < this.TTL;
  }

  /**
   * Clean expired entries from cache
   */
  private cleanCache(): void {
    if (this.cache.size < this.MAX_CACHE_SIZE) return;

    const now = Date.now();
    const entries = Array.from(this.cache.entries());
    
    // Sort by age (oldest first)
    entries.sort(([, a], [, b]) => a.cachedAt - b.cachedAt);
    
    let removedCount = 0;
    
    // Remove expired entries first
    for (const [key, cached] of entries) {
      if (now - cached.cachedAt > this.TTL) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    
    // If still over limit, remove oldest entries
    const remainingEntries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.cachedAt - b.cachedAt);
    
    while (this.cache.size > this.MAX_CACHE_SIZE) {
      const [oldestKey] = remainingEntries.shift()!;
      this.cache.delete(oldestKey);
      removedCount++;
    }

    if (removedCount > 0) {
      logger.debug("Prompt cache cleanup completed", {
        removedEntries: removedCount,
        remainingEntries: this.cache.size
      });
    }
  }
}

interface CacheStats {
  totalEntries: number;
  validEntries: number;
  hitRate: number;
  oldestEntry: number;
  newestEntry: number;
  averageContentLength: number;
}