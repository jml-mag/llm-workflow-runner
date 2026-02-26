// amplify/functions/workflow-runner/src/services/pineconeService.ts
import { Pinecone } from '@pinecone-database/pinecone';
import { Logger } from '@aws-lambda-powertools/logger';
import { loadSettings } from '../../../shared/settingsClient';

const logger = new Logger({ serviceName: 'pinecone-service' });

export interface PineconeStats {
  totalVectors: number;
  indexName: string;
  dimension: number;
  namespaces: Record<string, number>;
  indexFullness: number;
}

export interface PineconeHealth {
  healthy: boolean;
  message: string;
  responseTime?: number;
}

export interface VectorDeleteResult {
  deletedCount: number;
  vectorIds: string[];
}

export interface VectorUpdateResult {
  updatedCount: number;
  vectorIds: string[];
}

export interface VectorUpsertResult {
  upsertedCount: number;
  vectorIds: string[];
}

export interface PineconeVector {
  id: string;
  values: number[];
  metadata: Record<string, string | number | boolean>;
}

export class PineconeService {
  private client: Pinecone | null = null;
  private indexName: string;
  private dimension = 1024; // Default, overwritten in initialize()
  private _ready?: Promise<void>; // Singleton promise

  constructor() {
    this.indexName = process.env.PINECONE_INDEX_NAME || 'mag';
  }

  /** Call once at cold‑start of each Lambda */
  initialize(): Promise<void> {
    if (this._ready) return this._ready; // already in flight

    this._ready = (async () => {
      try {
        const settings = await loadSettings();
        this.dimension = settings.embeddingDimension ?? 1024;
        logger.info('PineconeService initialized with settings', { 
          dimension: this.dimension, 
          indexName: this.indexName 
        });
        
        await this.verifyOrCreateIndex(this.dimension);
      } catch (error) {
        logger.error('Failed to initialize PineconeService', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        // Keep default dimension on settings failure
        this.dimension = 1024;
        await this.verifyOrCreateIndex(this.dimension);
      }
    })();

    return this._ready;
  }

  private async initializeClient(): Promise<Pinecone> {
    if (!this.client) {
      const apiKey = process.env.PINECONE_API_KEY;
      if (!apiKey) {
        throw new Error('PINECONE_API_KEY environment variable is required');
      }

      this.client = new Pinecone({ apiKey });
      logger.info('Pinecone client initialized', { indexName: this.indexName });
    }
    return this.client;
  }

  /** Dimension validation helper */
  private validateVectorDim(values: number[]) {
    if (values.length !== this.dimension) {
      throw new Error(
        `Invalid vector dim ${values.length}, expected ${this.dimension}`
      );
    }
  }

  /** Index verification/creation helper */
  private async verifyOrCreateIndex(dimension: number) {
    const client = await this.initializeClient(); // ensures API key set
    try {
      const stats = await client.index(this.indexName).describeIndexStats();
      if (stats.dimension !== dimension) {
        throw new Error(
          `Pinecone index exists with dim ${stats.dimension}; need ${dimension}. Create new index or update settings.`
        );
      }
      logger.info('Pinecone index verified', { 
        indexName: this.indexName, 
        dimension: stats.dimension 
      });
    } catch (err) {
      if (
        err instanceof Error &&
        /status 404|not\s*found|does\s*not\s*exist/i.test(err.message)
      ) {
        logger.info('Creating new Pinecone index', { 
          indexName: this.indexName, 
          dimension 
        });
        await client.createIndex({
          name: this.indexName,
          spec: {
            serverless: {
              cloud: 'aws',
              region: process.env.AWS_REGION || 'us-east-1'
            }
          },
          dimension,
          metric: "cosine",
        });
        logger.info('Pinecone index created successfully', { 
          indexName: this.indexName, 
          dimension 
        });
      } else {
        throw err;
      }
    }
  }

  async getIndexStats(): Promise<PineconeStats> {
    const startTime = Date.now();
    
    try {
      logger.info('Getting Pinecone index statistics');
      
      const client = await this.initializeClient();
      const index = client.index(this.indexName);
      
      const stats = await index.describeIndexStats();
      
      // Validate dimension matches our settings
      if (stats.dimension !== this.dimension) {
        logger.warn('Pinecone index dimension mismatch detected', {
          indexDimension: stats.dimension,
          settingsDimension: this.dimension
        });
        throw new Error(
          `Pinecone index dim ${stats.dimension} ≠ Settings.dimension ${this.dimension}`
        );
      }
      
      // Convert namespaces to Record<string, number>
      const namespaces: Record<string, number> = {};
      if (stats.namespaces) {
        Object.entries(stats.namespaces).forEach(([key, value]) => {
          namespaces[key] = value.recordCount || 0;
        });
      }
      
      const result: PineconeStats = {
        totalVectors: stats.totalRecordCount || 0,
        indexName: this.indexName,
        dimension: stats.dimension || this.dimension,
        namespaces,
        indexFullness: stats.indexFullness || 0,
      };

      const duration = Date.now() - startTime;
      logger.info('Pinecone statistics retrieved', { 
        ...result,
        responseTime: duration
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Failed to get Pinecone statistics', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime: duration
      });
      throw new Error(`Pinecone stats error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async healthCheck(): Promise<PineconeHealth> {
    const startTime = Date.now();
    
    try {
      logger.info('Performing Pinecone health check');
      
      const client = await this.initializeClient();
      const index = client.index(this.indexName);
      
      // Simple health check - describe index stats
      await index.describeIndexStats();
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Pinecone health check passed', { responseTime });
      
      return {
        healthy: true,
        message: 'Pinecone index is accessible and responding',
        responseTime
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      logger.error('Pinecone health check failed', { 
        error: errorMessage,
        responseTime
      });
      
      return {
        healthy: false,
        message: `Pinecone error: ${errorMessage}`,
        responseTime
      };
    }
  }

  async deleteVectorsByContentId(contentId: string): Promise<VectorDeleteResult> {
    try {
      logger.info('Deleting vectors by content ID', { contentId });
      
      const client = await this.initializeClient();
      const index = client.index(this.indexName);
      
      // Query for vectors with matching parentId metadata
      const queryResponse = await index.query({
        vector: new Array(this.dimension).fill(0), // Use dynamic dimension
        topK: 1000, // Max vectors to find
        includeMetadata: true,
        filter: {
          parentId: { $eq: contentId }
        }
      });

      const vectorIds = queryResponse.matches.map(match => match.id);
      
      if (vectorIds.length === 0) {
        logger.info('No vectors found for content ID', { contentId });
        return { deletedCount: 0, vectorIds: [] };
      }

      // Delete vectors in batches
      const batchSize = 100;
      let deletedCount = 0;
      
      for (let i = 0; i < vectorIds.length; i += batchSize) {
        const batch = vectorIds.slice(i, i + batchSize);
        await index.deleteMany(batch);
        deletedCount += batch.length;
        
        logger.info('Deleted vector batch', { 
          batchSize: batch.length,
          totalDeleted: deletedCount,
          remaining: vectorIds.length - deletedCount
        });
      }

      logger.info('Vector deletion completed', { 
        contentId,
        deletedCount,
        vectorIds: vectorIds.slice(0, 5) // Log first 5 IDs for debugging
      });

      return { deletedCount, vectorIds };
    } catch (error) {
      logger.error('Failed to delete vectors', { 
        contentId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  async updateVectorMetadata(contentId: string, metadataUpdates: Record<string, string | number | boolean>): Promise<VectorUpdateResult> {
    try {
      logger.info('Updating vector metadata', { contentId, metadataUpdates });
      
      const client = await this.initializeClient();
      const index = client.index(this.indexName);
      
      // Query for vectors with matching parentId metadata
      const queryResponse = await index.query({
        vector: new Array(this.dimension).fill(0), // Use dynamic dimension
        topK: 1000, // Max vectors to find
        includeMetadata: true,
        filter: {
          parentId: { $eq: contentId }
        }
      });

      const vectorIds = queryResponse.matches.map(match => match.id);
      
      if (vectorIds.length === 0) {
        logger.info('No vectors found for content ID', { contentId });
        return { updatedCount: 0, vectorIds: [] };
      }

      // Update vectors individually (Pinecone doesn't support batch metadata updates)
      const batchSize = 100;
      let updatedCount = 0;
      
      for (let i = 0; i < vectorIds.length; i += batchSize) {
        const batch = vectorIds.slice(i, i + batchSize);
        
        // Process each vector in the batch
        for (const vectorId of batch) {
          await index.update({
            id: vectorId,
            metadata: metadataUpdates
          });
          updatedCount++;
        }
        
        logger.info('Updated vector batch', { 
          batchSize: batch.length,
          totalUpdated: updatedCount,
          remaining: vectorIds.length - updatedCount
        });
      }

      logger.info('Vector metadata update completed', { 
        contentId,
        updatedCount,
        vectorIds: vectorIds.slice(0, 5) // Log first 5 IDs for debugging
      });

      return { updatedCount, vectorIds };
    } catch (error) {
      logger.error('Failed to update vector metadata', { 
        contentId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  async upsertVectors(vectors: PineconeVector[], userId?: string): Promise<VectorUpsertResult> {
    try {
      // Determine namespace: userId for user docs, 'system' for internal docs
      const namespace = userId === 'system' ? 'system' : userId;
      
      logger.info('Upserting vectors to Pinecone', { 
        vectorCount: vectors.length,
        indexName: this.indexName,
        expectedDimension: this.dimension,
        namespace
      });

      if (vectors.length === 0) {
        logger.warn('No vectors provided for upsert');
        return { upsertedCount: 0, vectorIds: [] };
      }

      const client = await this.initializeClient();
      const index = client.index(this.indexName);

      // Validate vector dimensions using dynamic dimension
      for (const vector of vectors) {
        this.validateVectorDim(vector.values);
      }

      // Upsert vectors in batches
      const BATCH_SIZE = 100;
      let totalUpserted = 0;
      const allVectorIds: string[] = [];

      for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
        const batch = vectors.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(vectors.length / BATCH_SIZE);

        logger.info('Upserting vector batch', {
          batchNumber,
          totalBatches,
          vectorsInBatch: batch.length,
          namespace
        });

        try {
          // Pinecone upsert handles namespace differently - pass as separate parameter
          if (namespace) {
            await index.namespace(namespace).upsert(batch);
          } else {
            await index.upsert(batch);
          }
          
          totalUpserted += batch.length;
          allVectorIds.push(...batch.map(v => v.id));

          logger.info('Vector batch upserted successfully', {
            batchNumber,
            vectorsUpserted: batch.length,
            totalUpserted,
            namespace
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Failed to upsert vector batch', {
            batchNumber,
            error: errorMessage,
            vectorsInBatch: batch.length,
            namespace
          });
          throw new Error(`Batch ${batchNumber} upsert failed: ${errorMessage}`);
        }

        // Small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < vectors.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      logger.info('All vectors upserted successfully', {
        totalUpserted,
        indexName: this.indexName,
        totalBatches: Math.ceil(vectors.length / BATCH_SIZE),
        dimension: this.dimension,
        namespace
      });

      return {
        upsertedCount: totalUpserted,
        vectorIds: allVectorIds
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Vector upsert operation failed', {
        error: errorMessage,
        vectorCount: vectors.length,
        indexName: this.indexName,
        dimension: this.dimension,
        userId
      });
      throw new Error(`Failed to upsert vectors: ${errorMessage}`);
    }
  }

  async validateVector(vector: PineconeVector): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    if (!vector.id || vector.id.trim().length === 0) {
      errors.push('Vector ID is required and cannot be empty');
    }
    
    if (!Array.isArray(vector.values)) {
      errors.push('Vector values must be an array');
    } else if (vector.values.length !== this.dimension) {
      errors.push(`Vector dimension must be ${this.dimension}, got ${vector.values.length}`);
    } else if (vector.values.some(v => typeof v !== 'number' || isNaN(v))) {
      errors.push('Vector values must be valid numbers');
    }
    
    if (!vector.metadata || typeof vector.metadata !== 'object') {
      errors.push('Vector metadata must be an object');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  async deleteVectorsByIds(vectorIds: string[], namespace?: string): Promise<VectorDeleteResult> {
  try {
    logger.info('Deleting vectors by IDs', { 
      vectorCount: vectorIds.length,
      indexName: this.indexName,
      namespace 
    });

    if (vectorIds.length === 0) {
      return { deletedCount: 0, vectorIds: [] };
    }

    const client = await this.initializeClient();
    const index = client.index(this.indexName);

    // Delete in batches
    const BATCH_SIZE = 100;
    let deletedCount = 0;

    for (let i = 0; i < vectorIds.length; i += BATCH_SIZE) {
      const batch = vectorIds.slice(i, i + BATCH_SIZE);
      
      // Use namespace if provided
      if (namespace) {
        await index.namespace(namespace).deleteMany(batch);
      } else {
        await index.deleteMany(batch);
      }
      
      deletedCount += batch.length;

      logger.info('Deleted vector batch', {
        batchSize: batch.length,
        totalDeleted: deletedCount,
        remaining: vectorIds.length - deletedCount,
        namespace
      });
    }

    logger.info('Vector deletion by IDs completed', {
      deletedCount,
      indexName: this.indexName,
      namespace
    });

    return { deletedCount, vectorIds };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to delete vectors by IDs', {
      error: errorMessage,
      vectorCount: vectorIds.length,
      namespace
    });
    throw new Error(`Failed to delete vectors: ${errorMessage}`);
  }
}

  async queryVectorsByContent(contentId: string, limit: number = 10) {
    try {
      const client = await this.initializeClient();
      const index = client.index(this.indexName);
      
      const queryResponse = await index.query({
        vector: new Array(this.dimension).fill(0), // Use dynamic dimension
        topK: limit,
        includeMetadata: true,
        filter: {
          parentId: { $eq: contentId }
        }
      });

      return queryResponse.matches;
    } catch (error) {
      logger.error('Failed to query vectors by content', { 
        contentId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // Updated method for namespace support with multi-tenancy and collection filtering
  async queryVectors(
    queryVector: number[],
    topK: number = 10,
    userId?: string,
    filter?: Record<string, unknown>,
    allowedDocumentIds?: string[]
  ) {
    try {
      this.validateVectorDim(queryVector);
      const client = await this.initializeClient();
      const index = client.index(this.indexName);

      const namespace = userId === 'system' ? 'system' : userId;

      let combinedFilter: Record<string, unknown> | undefined = filter;

      if (allowedDocumentIds && allowedDocumentIds.length > 0) {
        const documentFilter: Record<string, unknown> = { documentId: { $in: allowedDocumentIds } };
        combinedFilter = filter
          ? { $and: [filter, documentFilter] }
          : documentFilter;
      }

      const queryOptions = {
        vector: queryVector,
        topK,
        filter: combinedFilter,
        includeMetadata: true,
        includeValues: false
      };

      logger.info('Querying vectors', {
        topK,
        namespace,
        hasFilter: !!combinedFilter,
        hasDocumentFilter: !!(allowedDocumentIds && allowedDocumentIds.length > 0),
        allowedDocumentCount: allowedDocumentIds?.length ?? 0,
        dimension: this.dimension
      });

      // Use namespace method on index if namespace is provided
      let queryResponse;
      if (namespace) {
        queryResponse = await index.namespace(namespace).query(queryOptions);
      } else {
        queryResponse = await index.query(queryOptions);
      }

      return queryResponse;
    } catch (error) {
      logger.error('Failed to query vectors', { 
        topK,
        namespace: userId,
        hasDocumentFilter: !!(allowedDocumentIds && allowedDocumentIds.length > 0),
        allowedDocumentCount: allowedDocumentIds?.length ?? 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
}