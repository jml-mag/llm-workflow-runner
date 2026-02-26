// amplify/functions/workflow-runner/src/prompt-engine/managers/PointerResolver.ts
import { Logger } from "@aws-lambda-powertools/logger";
import type { Schema } from "@platform/data/resource";

const logger = new Logger({ serviceName: "PromptEngine.PointerResolver" });

export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

export interface BasePromptVersion {
  id: string;
  content: string;
  contentHash: string;
  contentS3Key?: string;
  modelId: string;
  workflowId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
}

export interface ActivePromptPointer {
  id: string;
  tenantId?: string;
  modelId: string;
  scope: string;
  activeVersionId: string;
  previousVersionId?: string;
  pointerVersion: number;
  updatedAt: string;
  updatedBy: string;
}

interface CachedPrompt {
  prompt: BasePromptVersion;
  cachedAt: number;
  source: 'workflow' | 'model' | 'global' | 'emergency';
}

/**
 * Resolves active prompt versions using intelligent precedence rules
 * 
 * Priority Order:
 * 1. Tenant + Workflow + Model specific
 * 2. Workflow + Model specific  
 * 3. Tenant + Model specific
 * 4. Model specific (global)
 * 5. Emergency fallback
 */
export class PointerResolver {
  private cache = new Map<string, CachedPrompt>();
  private readonly TTL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 200;
  private cacheHit = false;

  constructor(private readonly dataClient: DataClient) {}

  /**
   * Main resolution method with intelligent precedence and caching
   */
  async resolveActivePrompt(
    workflowId: string | null,
    modelId: string,
    tenantId: string | null
  ): Promise<BasePromptVersion> {
    const startTime = Date.now();

    logger.info("Resolving active prompt", {
      workflowId,
      modelId,
      tenantId
    });

    // Build cache keys in precedence order
    const cacheKeys = this.buildCacheKeys(workflowId, modelId, tenantId);

    // Check cache for any matching key in precedence order
    for (const { key, source } of cacheKeys) {
      const cached = this.cache.get(key);
      if (cached && this.isCacheValid(cached)) {
        this.cacheHit = true;
        
        logger.debug("Prompt cache hit", {
          cacheKey: key,
          source,
          promptVersion: cached.prompt.id,
          cacheAge: Date.now() - cached.cachedAt
        });

        return cached.prompt;
      }
    }

    try {
      // Try resolution strategies in precedence order
      this.cacheHit = false;
      const resolution = await this.resolveWithPrecedence(workflowId, modelId, tenantId);

      // Cache the successful result
      const cacheKey = this.buildPrimaryCacheKey(workflowId, modelId, tenantId);
      this.cache.set(cacheKey, {
        prompt: resolution.prompt,
        cachedAt: Date.now(),
        source: resolution.source
      });

      // Clean cache if needed
      this.cleanCache();

      const resolveTime = Date.now() - startTime;

      logger.info("Prompt resolved successfully", {
        promptId: resolution.prompt.id,
        source: resolution.source,
        workflowSpecific: !!resolution.prompt.workflowId,
        tenantSpecific: !!resolution.prompt.tenantId,
        resolveTime,
        contentLength: resolution.prompt.content.length
      });

      return resolution.prompt;

    } catch (error) {
      const resolveTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      logger.error("Prompt resolution failed, using emergency fallback", {
        error: errorMessage,
        workflowId,
        modelId,
        tenantId,
        resolveTime
      });

      // Return emergency fallback - never fail completely
      return this.getEmergencyFallbackPrompt(modelId);
    }
  }

  /**
   * Build cache keys in precedence order
   */
  private buildCacheKeys(
    workflowId: string | null,
    modelId: string,
    tenantId: string | null
  ): Array<{ key: string; source: 'workflow' | 'model' | 'global' | 'emergency' }> {
    const keys: Array<{ key: string; source: 'workflow' | 'model' | 'global' | 'emergency' }> = [];

    // 1. Tenant + Workflow + Model
    if (tenantId && workflowId) {
      keys.push({ key: `${tenantId}:${workflowId}:${modelId}`, source: 'workflow' });
    }

    // 2. Workflow + Model (no tenant)
    if (workflowId) {
      keys.push({ key: `null:${workflowId}:${modelId}`, source: 'workflow' });
    }

    // 3. Tenant + Model (no workflow)
    if (tenantId) {
      keys.push({ key: `${tenantId}:GLOBAL:${modelId}`, source: 'model' });
    }

    // 4. Model only (global)
    keys.push({ key: `null:GLOBAL:${modelId}`, source: 'global' });

    return keys;
  }

  /**
   * Build primary cache key for storing results
   */
  private buildPrimaryCacheKey(
    workflowId: string | null,
    modelId: string,
    tenantId: string | null
  ): string {
    return `${tenantId || 'null'}:${workflowId || 'GLOBAL'}:${modelId}`;
  }

  /**
   * Resolve prompt using precedence rules
   */
  private async resolveWithPrecedence(
    workflowId: string | null,
    modelId: string,
    tenantId: string | null
  ): Promise<{ prompt: BasePromptVersion; source: 'workflow' | 'model' | 'global' | 'emergency' }> {
    
    // Strategy 1: Tenant + Workflow + Model specific
    if (tenantId && workflowId) {
      const prompt = await this.resolveSpecificPointer(tenantId, workflowId, modelId);
      if (prompt) {
        return { prompt, source: 'workflow' };
      }
    }

    // Strategy 2: Workflow + Model specific (no tenant constraint)
    if (workflowId) {
      const prompt = await this.resolveSpecificPointer(null, workflowId, modelId);
      if (prompt) {
        return { prompt, source: 'workflow' };
      }
    }

    // Strategy 3: Tenant + Model specific (no workflow)
    if (tenantId) {
      const prompt = await this.resolveSpecificPointer(tenantId, 'GLOBAL', modelId);
      if (prompt) {
        return { prompt, source: 'model' };
      }
    }

    // Strategy 4: Model specific global default
    const globalPrompt = await this.resolveSpecificPointer(null, 'GLOBAL', modelId);
    if (globalPrompt) {
      return { prompt: globalPrompt, source: 'global' };
    }

    // Strategy 5: Emergency fallback
    return { 
      prompt: this.getEmergencyFallbackPrompt(modelId), 
      source: 'emergency' 
    };
  }

  /**
   * Resolve specific pointer and get associated prompt version
   */
  private async resolveSpecificPointer(
    tenantId: string | null,
    scope: string,
    modelId: string
  ): Promise<BasePromptVersion | null> {
    try {
      // Find active pointer
      const pointerResult = await this.dataClient.models.ActivePromptPointer.list({
        filter: {
          tenantId: tenantId ? { eq: tenantId } : { attributeExists: false },
          modelId: { eq: modelId },
          scope: { eq: scope }
        },
        limit: 1
      });

      if (!pointerResult.data || pointerResult.data.length === 0) {
        logger.debug("No active pointer found", { tenantId, scope, modelId });
        return null;
      }

      const pointer = pointerResult.data[0];

      // Get the prompt version
      const versionResult = await this.dataClient.models.BasePromptVersion.get({
        id: pointer.activeVersionId
      });

      if (!versionResult.data) {
        logger.warn("Active pointer references non-existent version", {
          pointerId: pointer.id,
          activeVersionId: pointer.activeVersionId,
          tenantId,
          scope,
          modelId
        });
        return null;
      }

      const version = versionResult.data;

      return {
        id: version.id,
        content: version.content,
        contentHash: version.contentHash,
        contentS3Key: version.contentS3Key || undefined,
        modelId: version.modelId,
        workflowId: version.workflowId || undefined,
        tenantId: version.tenantId || undefined,
        metadata: version.metadata as Record<string, unknown> || undefined,
        createdAt: version.createdAt,
        createdBy: version.createdBy
      };

    } catch (error) {
      logger.warn("Failed to resolve specific pointer", {
        error: error instanceof Error ? error.message : "Unknown error",
        tenantId,
        scope,
        modelId
      });
      return null;
    }
  }

  /**
   * Emergency fallback prompt - never fails
   */
  private getEmergencyFallbackPrompt(modelId: string): BasePromptVersion {
    const content = `You are an AI assistant operating within an automated workflow execution system.

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
      contentHash: "emergency-fallback-hash",
      modelId,
      createdAt: new Date().toISOString(),
      createdBy: "SYSTEM"
    };
  }

  /**
   * Check if cached prompt is still valid
   */
  private isCacheValid(cached: CachedPrompt): boolean {
    return Date.now() - cached.cachedAt < this.TTL;
  }

  /**
   * Clean expired and excess entries from cache
   */
  private cleanCache(): void {
    if (this.cache.size < this.MAX_CACHE_SIZE) return;

    const now = Date.now();
    const entries = Array.from(this.cache.entries());
    
    // Remove expired entries first
    for (const [key, cached] of entries) {
      if (now - cached.cachedAt > this.TTL) {
        this.cache.delete(key);
      }
    }
    
    // If still over limit, remove oldest entries
    if (this.cache.size > this.MAX_CACHE_SIZE) {
      const remainingEntries = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.cachedAt - b.cachedAt);
      
      while (this.cache.size > this.MAX_CACHE_SIZE && remainingEntries.length > 0) {
        const [oldestKey] = remainingEntries.shift()!;
        this.cache.delete(oldestKey);
      }
    }

    logger.debug("Cache cleanup completed", {
      remainingEntries: this.cache.size
    });
  }

  /**
   * Invalidate cache entries matching patterns
   */
  invalidateCache(pattern?: {
    workflowId?: string;
    modelId?: string;
    tenantId?: string;
  }): void {
    if (!pattern) {
      // Clear entire cache
      this.cache.clear();
      logger.info("Entire prompt cache cleared");
      return;
    }

    const keysToRemove: string[] = [];

    for (const [key] of this.cache.entries()) {
      const [cachedTenantId, cachedScope, cachedModelId] = key.split(':');
      
      const shouldRemove = 
        (!pattern.tenantId || cachedTenantId === pattern.tenantId || cachedTenantId === 'null') &&
        (!pattern.workflowId || cachedScope === pattern.workflowId || cachedScope === 'GLOBAL') &&
        (!pattern.modelId || cachedModelId === pattern.modelId);
      
      if (shouldRemove) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => this.cache.delete(key));
    
    logger.info("Selective cache invalidation completed", {
      removedKeys: keysToRemove.length,
      pattern
    });
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): {
    totalEntries: number;
    validEntries: number;
    hitRate: number;
    oldestEntry: number;
    newestEntry: number;
  } {
    const entries = Array.from(this.cache.values());
    const validEntries = entries.filter(entry => this.isCacheValid(entry));
    
    return {
      totalEntries: entries.length,
      validEntries: validEntries.length,
      hitRate: 0, // Would need to track hits/misses over time
      oldestEntry: entries.length > 0 ? Math.min(...entries.map(e => e.cachedAt)) : 0,
      newestEntry: entries.length > 0 ? Math.max(...entries.map(e => e.cachedAt)) : 0
    };
  }

  /**
   * Check if last resolution was a cache hit
   */
  wasCacheHit(): boolean {
    return this.cacheHit;
  }
}