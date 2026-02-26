// src/config/env.ts
//
// Centralized environment configuration for the Workflow Runner.
// All environment variables are read here and exposed as typed values
// with sensible defaults. Import ENV from this module instead of
// scattering process.env reads across the codebase.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function strRequired(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function strOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "1" || v === "true";
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

export const AWS_REGION = str("AWS_REGION", "us-east-1");

// ---------------------------------------------------------------------------
// Model defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_ID = str(
  "DEFAULT_MODEL_ID",
  "us.anthropic.claude-3-7-sonnet-20250219-v1:0"
);

export const BEDROCK_MODEL = str(
  "BEDROCK_MODEL",
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
);

// ---------------------------------------------------------------------------
// Amplify / AppSync
// ---------------------------------------------------------------------------

/** GraphQL endpoint — required at runtime when the data layer is active. */
export const AMPLIFY_DATA_GRAPHQL_ENDPOINT = strOptional("AMPLIFY_DATA_GRAPHQL_ENDPOINT");
export const AMPLIFY_DATA_REGION = str("AMPLIFY_DATA_REGION", AWS_REGION);

// ---------------------------------------------------------------------------
// Prompt engine
// ---------------------------------------------------------------------------

export const USE_NEW_PROMPT_ENGINE = bool("USE_NEW_PROMPT_ENGINE", true);

// ---------------------------------------------------------------------------
// Prompt archiving (S3)
// ---------------------------------------------------------------------------

export const PROMPT_ARCHIVE_ENABLED = bool("PROMPT_ARCHIVE", false);
export const PROMPT_ARCHIVE_BUCKET = strOptional("PROMPT_ARCHIVE_BUCKET");
export const PROMPT_ARCHIVE_MAX_LINES = num("PROMPT_ARCHIVE_MAX_LINES", 8);
export const PROMPT_ARCHIVE_MAX_CHARS = num("PROMPT_ARCHIVE_MAX_CHARS", 1500);
export const PROMPT_ARCHIVE_REDACT = bool("PROMPT_ARCHIVE_REDACT", false);

// ---------------------------------------------------------------------------
// Prompt content storage (S3 + KMS)
// ---------------------------------------------------------------------------

export const STORAGE_BUCKET_NAME = strOptional("STORAGE_BUCKET_NAME");
export const PROMPT_CONTENT_KMS_KEY_ID = strOptional("PROMPT_CONTENT_KMS_KEY_ID");
export const PROMPT_CONTENT_KMS_KEY_ARN = strOptional("PROMPT_CONTENT_KMS_KEY_ARN");

// ---------------------------------------------------------------------------
// Prompt logging / sampling
// ---------------------------------------------------------------------------

export const PROMPT_LOG_SAMPLE_RATE = num("PROMPT_LOG_SAMPLE_RATE", 0);
export const PROMPT_LOG_MAX_CHARS = num("PROMPT_LOG_MAX_CHARS", 2000);

// ---------------------------------------------------------------------------
// Third-party API keys
// ---------------------------------------------------------------------------

export const OPENAI_API_KEY = strOptional("OPENAI_API_KEY");
export const PINECONE_API_KEY = strOptional("PINECONE_API_KEY");
export const PINECONE_INDEX_NAME = str("PINECONE_INDEX_NAME", "mag");

// ---------------------------------------------------------------------------
// Cost controls (used by TokenBudget)
// ---------------------------------------------------------------------------

export const DEFAULT_REQUEST_COST_CAP_USD = num("DEFAULT_REQUEST_COST_CAP_USD", 5.0);
export const DEFAULT_TOKEN_CAP = num("DEFAULT_TOKEN_CAP", 100000);
export const EMERGENCY_COST_THRESHOLD_USD = num("EMERGENCY_COST_THRESHOLD_USD", 25.0);

// ---------------------------------------------------------------------------
// Lambda runtime context (read-only, provided by AWS)
// ---------------------------------------------------------------------------

export const AWS_LAMBDA_FUNCTION_NAME = strOptional("AWS_LAMBDA_FUNCTION_NAME");
export const AWS_LAMBDA_FUNCTION_VERSION = strOptional("AWS_LAMBDA_FUNCTION_VERSION");
export const AWS_REQUEST_ID = strOptional("AWS_REQUEST_ID");
export const LAMBDA_TASK_ROOT = strOptional("LAMBDA_TASK_ROOT");
export const NODE_ENV = str("NODE_ENV", "production");

// ---------------------------------------------------------------------------
// Convenience namespace (import { ENV } from "@/config/env")
// ---------------------------------------------------------------------------

export const ENV = {
  // AWS
  region: AWS_REGION,

  // Models
  defaultModelId: DEFAULT_MODEL_ID,
  bedrockModel: BEDROCK_MODEL,

  // Amplify / AppSync
  amplifyGraphqlEndpoint: AMPLIFY_DATA_GRAPHQL_ENDPOINT,
  amplifyDataRegion: AMPLIFY_DATA_REGION,

  // Prompt engine
  useNewPromptEngine: USE_NEW_PROMPT_ENGINE,

  // Prompt archiving
  promptArchiveEnabled: PROMPT_ARCHIVE_ENABLED,
  promptArchiveBucket: PROMPT_ARCHIVE_BUCKET,
  promptArchiveMaxLines: PROMPT_ARCHIVE_MAX_LINES,
  promptArchiveMaxChars: PROMPT_ARCHIVE_MAX_CHARS,
  promptArchiveRedact: PROMPT_ARCHIVE_REDACT,

  // Prompt content storage
  storageBucketName: STORAGE_BUCKET_NAME,
  promptContentKmsKeyId: PROMPT_CONTENT_KMS_KEY_ID,
  promptContentKmsKeyArn: PROMPT_CONTENT_KMS_KEY_ARN,

  // Prompt logging
  promptLogSampleRate: PROMPT_LOG_SAMPLE_RATE,
  promptLogMaxChars: PROMPT_LOG_MAX_CHARS,

  // Third-party keys
  openaiApiKey: OPENAI_API_KEY,
  pineconeApiKey: PINECONE_API_KEY,
  pineconeIndexName: PINECONE_INDEX_NAME,

  // Cost controls
  defaultRequestCostCapUsd: DEFAULT_REQUEST_COST_CAP_USD,
  defaultTokenCap: DEFAULT_TOKEN_CAP,
  emergencyCostThresholdUsd: EMERGENCY_COST_THRESHOLD_USD,

  // Lambda context
  lambdaFunctionName: AWS_LAMBDA_FUNCTION_NAME,
  lambdaFunctionVersion: AWS_LAMBDA_FUNCTION_VERSION,
  awsRequestId: AWS_REQUEST_ID,
  lambdaTaskRoot: LAMBDA_TASK_ROOT,
  nodeEnv: NODE_ENV,
} as const;

export default ENV;
