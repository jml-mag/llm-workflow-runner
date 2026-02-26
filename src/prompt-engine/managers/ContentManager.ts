// amplify/functions/workflow-runner/src/prompt-engine/managers/ContentManager.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import type { Schema } from "@platform/data/resource";
import type { BasePromptVersion } from "./PointerResolver";

const logger = new Logger({ serviceName: "PromptEngine.ContentManager" });
const metrics = new Metrics({ serviceName: "PromptEngine.ContentManager" });

export type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

const s3Client = new S3Client({});
const STORAGE_BUCKET = process.env.STORAGE_BUCKET_NAME!;
const PROMPT_CONTENT_KMS_KEY_ID = process.env.PROMPT_CONTENT_KMS_KEY_ID!;
const MAX_INLINE_CONTENT_SIZE = 300000; // 300KB - store larger content in S3

interface CreateVersionParams {
  content: string;
  modelId: string;
  workflowId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

interface ContentStore {
  content?: string;
  contentS3Key?: string;
}

export class PromptEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PromptEngineError';
  }
}

/**
 * Content Manager for prompt storage with S3 overflow and integrity verification
 * Handles both inline and S3-based storage based on content size
 */
export class ContentManager {
  constructor(private readonly dataClient: DataClient) {}

  /**
   * Create a new immutable prompt version with integrity checking
   */
  async createVersion(params: CreateVersionParams): Promise<BasePromptVersion> {
    const startTime = Date.now();

    logger.info("Creating new prompt version", {
      modelId: params.modelId,
      workflowId: params.workflowId,
      tenantId: params.tenantId,
      contentLength: params.content.length,
      createdBy: params.createdBy
    });

    // Calculate content hash for integrity verification
    const contentHash = createHash('sha256')
      .update(params.content, 'utf8')
      .digest('hex');

    // Check for duplicate content to prevent storage waste
    const duplicateCheck = await this.checkForDuplicate(contentHash);
    if (duplicateCheck) {
      throw new PromptEngineError(
        'DUPLICATE_CONTENT',
        'Content already exists with same hash',
        {
          existingVersionId: duplicateCheck.id,
          contentHash,
          modelId: params.modelId
        }
      );
    }

    // Determine storage strategy based on content size
    const contentStore = await this.storeContent(params.content, contentHash);

    try {
      // Create immutable version record - Fixed: ensure content is always string
      const createData = {
        content: contentStore.content || '', // Fixed: provide empty string if undefined
        contentS3Key: contentStore.contentS3Key || null, // Fixed: use null instead of undefined
        contentHash,
        modelId: params.modelId,
        workflowId: params.workflowId || null, // Fixed: use null for optional fields
        tenantId: params.tenantId || null, // Fixed: use null for optional fields
        metadata: params.metadata ? JSON.stringify(params.metadata) : null, // Fixed: stringify metadata
        createdAt: new Date().toISOString(),
        createdBy: params.createdBy,
      };

      const versionResult = await this.dataClient.models.BasePromptVersion.create(createData);

      if (!versionResult.data) {
        throw new PromptEngineError(
          'VERSION_CREATION_FAILED',
          'Failed to create prompt version record'
        );
      }

      const creationTime = Date.now() - startTime;

      // Record success metrics
      metrics.addMetric('VersionCreated', MetricUnit.Count, 1);
      metrics.addMetric('VersionCreationLatency', MetricUnit.Milliseconds, creationTime);
      metrics.addMetric('ContentSize', MetricUnit.Bytes, params.content.length);
      
      if (contentStore.contentS3Key) {
        metrics.addMetric('S3StorageUsed', MetricUnit.Count, 1);
      }

      logger.info("Prompt version created successfully", {
        versionId: versionResult.data.id,
        contentHash,
        storageType: contentStore.contentS3Key ? 's3' : 'inline',
        creationTime,
        contentSize: params.content.length
      });

      return {
        id: versionResult.data.id,
        content: versionResult.data.content || '',
        contentHash: versionResult.data.contentHash,
        contentS3Key: versionResult.data.contentS3Key || undefined, // Fixed: handle null to undefined
        modelId: versionResult.data.modelId,
        workflowId: versionResult.data.workflowId || undefined, // Fixed: handle null to undefined
        tenantId: versionResult.data.tenantId || undefined, // Fixed: handle null to undefined
        metadata: versionResult.data.metadata ? 
          (typeof versionResult.data.metadata === 'string' ? 
            JSON.parse(versionResult.data.metadata) : 
            versionResult.data.metadata as Record<string, unknown>
          ) : 
          undefined,
        createdAt: versionResult.data.createdAt,
        createdBy: versionResult.data.createdBy
      };

    } catch (error) {
      // Clean up S3 object if database creation failed
      if (contentStore.contentS3Key) {
        await this.cleanupS3Content(contentStore.contentS3Key);
      }

      const creationTime = Date.now() - startTime;
      metrics.addMetric('VersionCreationFailure', MetricUnit.Count, 1);
      
      logger.error("Prompt version creation failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        contentHash,
        modelId: params.modelId,
        creationTime
      });

      throw error;
    }
  }

  /**
   * Get content from version (handles both inline and S3 storage)
   */
  async getContent(version: BasePromptVersion): Promise<string> {
    const startTime = Date.now();

    try {
      // Content stored inline
      if (version.content) {
        logger.debug("Retrieved inline content", {
          versionId: version.id,
          contentLength: version.content.length
        });
        
        return version.content;
      }

      // Content stored in S3
      if (version.contentS3Key) {
        const s3Content = await this.getS3Content(version.contentS3Key);
        
        const retrievalTime = Date.now() - startTime;
        
        metrics.addMetric('S3ContentRetrieved', MetricUnit.Count, 1);
        metrics.addMetric('S3RetrievalLatency', MetricUnit.Milliseconds, retrievalTime);

        logger.debug("Retrieved S3 content", {
          versionId: version.id,
          s3Key: version.contentS3Key,
          contentLength: s3Content.length,
          retrievalTime
        });

        return s3Content;
      }

      throw new PromptEngineError(
        'NO_CONTENT_FOUND',
        'Version has neither inline content nor S3 key',
        { versionId: version.id }
      );

    } catch (error) {
      const retrievalTime = Date.now() - startTime;
      
      metrics.addMetric('ContentRetrievalFailure', MetricUnit.Count, 1);
      
      logger.error("Content retrieval failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        versionId: version.id,
        hasInlineContent: !!version.content,
        hasS3Key: !!version.contentS3Key,
        retrievalTime
      });

      throw error;
    }
  }

  /**
   * Verify content integrity using SHA-256 hash
   */
  async verifyContentIntegrity(version: BasePromptVersion): Promise<boolean> {
    const startTime = Date.now();

    try {
      const content = await this.getContent(version);
      
      const actualHash = createHash('sha256')
        .update(content, 'utf8')
        .digest('hex');

      const isValid = actualHash === version.contentHash;
      const verificationTime = Date.now() - startTime;

      if (!isValid) {
        logger.error('Content integrity violation detected', {
          versionId: version.id,
          expectedHash: version.contentHash,
          actualHash,
          contentLength: content.length,
          verificationTime
        });

        metrics.addMetric('ContentIntegrityViolation', MetricUnit.Count, 1);
        return false;
      }

      logger.debug("Content integrity verified", {
        versionId: version.id,
        contentHash: version.contentHash,
        verificationTime
      });

      metrics.addMetric('ContentIntegrityVerified', MetricUnit.Count, 1);
      metrics.addMetric('IntegrityVerificationLatency', MetricUnit.Milliseconds, verificationTime);

      return true;

    } catch (error) {
      const verificationTime = Date.now() - startTime;
      
      logger.error("Content integrity verification failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        versionId: version.id,
        verificationTime
      });

      metrics.addMetric('IntegrityVerificationFailure', MetricUnit.Count, 1);
      return false;
    }
  }

  /**
   * Store content using appropriate strategy (inline vs S3)
   */
  private async storeContent(content: string, contentHash: string): Promise<ContentStore> {
    const contentSize = Buffer.byteLength(content, 'utf8');

    // Store inline if content is small enough
    if (contentSize <= MAX_INLINE_CONTENT_SIZE) {
      logger.debug("Storing content inline", { 
        contentSize,
        contentHash
      });
      
      return { content };
    }

    // Store in S3 for large content
    const s3Key = `prompt-content/${contentHash}`;
    
    logger.info("Storing large content in S3", {
      contentSize,
      s3Key,
      threshold: MAX_INLINE_CONTENT_SIZE
    });

    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: s3Key,
        Body: content,
        ContentType: 'text/plain; charset=utf-8',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: PROMPT_CONTENT_KMS_KEY_ID,
        Metadata: {
          'content-hash': contentHash,
          'storage-type': 'prompt-content',
          'created-at': new Date().toISOString(),
        },
      }));

      logger.debug("Content stored in S3 successfully", {
        s3Key,
        contentSize,
        contentHash
      });

      return { contentS3Key: s3Key };

    } catch (error) {
      logger.error("Failed to store content in S3", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Key,
        contentSize,
        contentHash
      });

      throw new PromptEngineError(
        'S3_STORAGE_FAILED',
        `Failed to store content in S3: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { s3Key, contentSize }
      );
    }
  }

  /**
   * Retrieve content from S3
   */
  private async getS3Content(s3Key: string): Promise<string> {
    try {
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: s3Key,
      }));

      if (!response.Body) {
        throw new PromptEngineError(
          'S3_EMPTY_RESPONSE',
          'S3 response body is empty',
          { s3Key }
        );
      }

      const content = await response.Body.transformToString('utf-8');
      
      logger.debug("S3 content retrieved successfully", {
        s3Key,
        contentLength: content.length,
        lastModified: response.LastModified?.toISOString()
      });

      return content;

    } catch (error) {
      logger.error("Failed to retrieve content from S3", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Key
      });

      throw new PromptEngineError(
        'S3_RETRIEVAL_FAILED',
        `Failed to retrieve content from S3: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { s3Key }
      );
    }
  }

  /**
   * Check for duplicate content by hash - Fixed: use list instead of listByContentHash
   */
  private async checkForDuplicate(contentHash: string): Promise<BasePromptVersion | null> {
    try {
      const duplicates = await this.dataClient.models.BasePromptVersion.list({
        filter: {
          contentHash: { eq: contentHash }
        },
        limit: 1
      });

      if (duplicates.data && duplicates.data.length > 0) {
        const existing = duplicates.data[0];
        
        logger.debug("Found duplicate content", {
          contentHash,
          existingVersionId: existing.id,
          modelId: existing.modelId
        });

        return {
          id: existing.id,
          content: existing.content || '',
          contentHash: existing.contentHash,
          contentS3Key: existing.contentS3Key || undefined,
          modelId: existing.modelId,
          workflowId: existing.workflowId || undefined,
          tenantId: existing.tenantId || undefined,
          metadata: existing.metadata ? 
            (typeof existing.metadata === 'string' ? 
              JSON.parse(existing.metadata) : 
              existing.metadata as Record<string, unknown>
            ) : 
            undefined,
          createdAt: existing.createdAt,
          createdBy: existing.createdBy
        };
      }

      return null;

    } catch (error) {
      logger.warn("Failed to check for duplicate content", {
        error: error instanceof Error ? error.message : "Unknown error",
        contentHash
      });

      // Return null to allow creation to proceed if duplicate check fails
      return null;
    }
  }

  /**
   * Clean up S3 content (used when database operations fail)
   */
  private async cleanupS3Content(s3Key: string): Promise<void> {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: s3Key,
      }));

      logger.info("Cleaned up S3 content after failed operation", { s3Key });

    } catch (error) {
      logger.warn("Failed to clean up S3 content", {
        error: error instanceof Error ? error.message : "Unknown error",
        s3Key
      });
      // Don't throw - cleanup failure shouldn't fail the main operation
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    totalVersions: number;
    inlineVersions: number;
    s3Versions: number;
    averageContentSize: number;
  }> {
    try {
      const versions = await this.dataClient.models.BasePromptVersion.list({
        limit: 1000 // Adjust based on your needs
      });

      if (!versions.data) {
        return {
          totalVersions: 0,
          inlineVersions: 0,
          s3Versions: 0,
          averageContentSize: 0
        };
      }

      const totalVersions = versions.data.length;
      const inlineVersions = versions.data.filter(v => v.content).length;
      const s3Versions = versions.data.filter(v => v.contentS3Key).length;

      // Calculate average content size (approximate)
      let totalSize = 0;
      let sizeCount = 0;

      for (const version of versions.data) {
        if (version.content) {
          totalSize += Buffer.byteLength(version.content, 'utf8');
          sizeCount++;
        }
      }

      const averageContentSize = sizeCount > 0 ? Math.round(totalSize / sizeCount) : 0;

      return {
        totalVersions,
        inlineVersions,
        s3Versions,
        averageContentSize
      };

    } catch (error) {
      logger.error("Failed to get storage stats", {
        error: error instanceof Error ? error.message : "Unknown error"
      });

      return {
        totalVersions: 0,
        inlineVersions: 0,
        s3Versions: 0,
        averageContentSize: 0
      };
    }
  }
}