/**
 * Public-repo stub — typings/shared/settingsClient.ts
 *
 * In the full system this loads runtime settings from DynamoDB.
 * Here we provide just enough surface for the runner to typecheck.
 */

export interface PlatformSettings {
  embeddingDimension?: number;
  topK?: number;
  [key: string]: unknown;
}

/** Load platform-wide runtime settings. */
export declare function loadSettings(): Promise<PlatformSettings>;
