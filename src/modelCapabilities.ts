// amplify/functions/workflow-runner/src/modelCapabilities.ts

/**
 * Model capability registry for multi-provider orchestration.
 *
 * This file defines the canonical list of supported models,
 * their metadata, pricing, capabilities, workflow roles,
 * and API integration details.
 *
 * Designed for use in UI (workflow builder) and backend orchestration.
 *
 * @author Workflow Runner contributors
 * @version 1.5.0
 */

// =======================================
// Interfaces
// =======================================

/** Supported model providers */
export type ModelProvider =
  | 'openai'
  | 'anthropic'
  | 'amazon'
  | 'meta'

/** Pricing information per unit */
export interface ModelPricing {
  type: 'token' | 'minute' | 'image' | 'flat';
  inputCostPerUnit: number; // USD
  outputCostPerUnit: number; // USD
  unit: '1K tokens' | 'minute' | 'image' | 'call';
}

/** Input/output modalities supported */
export interface ModelModalities {
  input: Array<'text' | 'image' | 'audio' | 'video'>;
  output: Array<'text' | 'image' | 'audio' | 'video'>;
}

/** Parameter range metadata */
export interface ParameterSpec {
  min: number;
  max: number;
  default: number;
  step?: number;
}

/** All model parameters and their specs */
export interface ModelParameterSpecs {
  temperature?: ParameterSpec;
  topP?: ParameterSpec;
  topK?: ParameterSpec;
  frequencyPenalty?: ParameterSpec;
  presencePenalty?: ParameterSpec;
  maxTokens?: ParameterSpec;
  maxGenLen?: ParameterSpec; // Meta-specific
  cfgScale?: ParameterSpec; // Image generation
  steps?: ParameterSpec; // Image generation
  n?: ParameterSpec; // Number of generations
}

/** Advanced API quirks */
export interface APIConventions {
  systemPromptRequired?: boolean;
  imageInMessageSchema?: boolean;
  supportsFunctionCalling?: boolean;
  supportsJSONMode?: boolean;
  supportsStreaming?: boolean;
  extendedThinkingBlocks?: boolean;
}

/** Workflow roles for UX organization */
export type WorkflowRole =
  | 'generator'           // Produces new content (text, image, audio)
  | 'analyzer'            // Analyzes or interprets content
  | 'transformer'         // Transforms one type of data to another
  | 'agent'               // Acts as planner or orchestrator with tool use
  | 'embedding'           // Produces vector embeddings
  | 'preprocessor';       // Prepares data for downstream steps

/** Work types for UX categorization */
export type WorkType =
  | 'conversation'
  | 'content_creation'
  | 'code'
  | 'data_analysis'
  | 'document_processing'
  | 'image_generation'
  | 'audio_processing'
  | 'embedding'
  | 'agent_orchestration'
  | 'multimodal_composition';

/** Tokenizer configuration for prompt engine */
export interface TokenizerConfig {
  mode: 'exact' | 'approx' | 'off';
  provider: ModelProvider;
  estimationMethod: {
    charsPerToken: number;
    overhead: number;
  };
}

/** Canonical model capability definition */
export interface ModelCapability {
  id: string; // Unique identifier for the model
  displayName: string; // User-facing name
  provider: ModelProvider; // Source provider
  description: string; // Overview and strengths
  version?: string; // Optional display version
  releaseDate?: string; // YYYY-MM-DD
  trainingCutoff?: string; // YYYY-MM

  pricing: ModelPricing;
  contextWindow: number; // Max tokens in context
  regions?: string[]; // Available regions (AWS-specific)

  modalities: ModelModalities;
  parameterSpecs: ModelParameterSpecs;
  apiConventions: APIConventions;

  /** Prompt engine specific fields */
  tokenizer: TokenizerConfig;
  reservedOutputTokens: number;

  /** Logical UX grouping */
  workflowRoles: WorkflowRole[];
  workTypes: WorkType[];

  /**
   * API model identifiers for various inference types and providers.
   * For Bedrock, includes both `onDemand` and `serverless` IDs.
   */
  apiModelIds: ApiModelIds;
  defaultInferenceType?: 'onDemand' | 'serverless'; // Default inference type if applicable
}

/** API model ID structure to handle different inference types */
export interface ApiModelIds {
  /** Default ID for providers like OpenAI or single-endpoint models */
  default?: string;

  /** AWS Bedrock-specific IDs */
  bedrock?: {
    onDemand: string;
    serverless: string;
  };
}

/**
 * Pricing values below reflect publicly listed vendor rates as of Feb 2025.
 * They are included for educational / estimation purposes — check each
 * provider's pricing page for current numbers before production use.
 */
export const MODEL_REGISTRY: Record<string, ModelCapability> = {
  /** GPT-4 Omni (OpenAI API only, no Bedrock) */
  'gpt-4o': {
    id: 'gpt-4o',
    displayName: 'GPT-4 Omni',
    provider: 'openai',
    description:
      'Flagship multimodal LLM (text, vision, audio) with human-like latency; excels at code, math, and reasoning.',
    version: 'May 2024',
    releaseDate: '2024-05-13',
    trainingCutoff: '2024-06',

    pricing: {
      type: 'token',
      inputCostPerUnit: 0.005,
      outputCostPerUnit: 0.02,
      unit: '1K tokens',
    },
    contextWindow: 128000,
    modalities: {
      input: ['text', 'image', 'audio'],
      output: ['text'],
    },
    parameterSpecs: {
      temperature: { min: 0, max: 2, default: 1, step: 0.1 },
      topP: { min: 0, max: 1, default: 1, step: 0.01 },
      frequencyPenalty: { min: -2, max: 2, default: 0 },
      presencePenalty: { min: -2, max: 2, default: 0 },
      maxTokens: { min: 1, max: 16384, default: 1024 }, // API can allow up to ~16k output depending on deployment
    },
    apiConventions: {
      systemPromptRequired: true,
      imageInMessageSchema: true,
      supportsFunctionCalling: true,
      supportsJSONMode: true,
      supportsStreaming: true,
    },
    tokenizer: {
      mode: 'exact',
      provider: 'openai',
      estimationMethod: {
        charsPerToken: 4,
        overhead: 12,
      },
    },
    reservedOutputTokens: 16384, // leave room for max output on many deployments
    workflowRoles: ['generator', 'analyzer', 'agent'],
    workTypes: [
      'conversation',
      'content_creation',
      'code',
      'data_analysis',
      'document_processing',
      'multimodal_composition',
    ],
    apiModelIds: {
      default: 'gpt-4o', // OpenAI only
    },
  },

  /** Claude 3.7 Sonnet */
  'anthropic.claude-3-7-sonnet-20250219-v1:0': {
    id: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
    displayName: 'Claude 3.7 Sonnet',
    provider: 'anthropic',
    description: 'Hybrid reasoning, strong code generation, large-document RAG.',
    version: 'Feb 2025',
    releaseDate: '2025-02-19',
    trainingCutoff: '2024-12',

    pricing: {
      type: 'token',
      inputCostPerUnit: 0.003,
      outputCostPerUnit: 0.015,
      unit: '1K tokens',
    },
    contextWindow: 200000,
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
    parameterSpecs: {
      temperature: { min: 0, max: 1, default: 0.5, step: 0.05 },
      topP: { min: 0, max: 1, default: 1 },
      // note: output token limit can be raised with vendor-specific headers; we reserve conservatively below
    },
    apiConventions: {
      supportsFunctionCalling: true,
      supportsJSONMode: true,
      supportsStreaming: true,
      extendedThinkingBlocks: true,
    },
    tokenizer: {
      mode: 'approx',
      provider: 'anthropic',
      estimationMethod: {
        charsPerToken: 4,
        overhead: 15,
      },
    },
    reservedOutputTokens: 8192, // safe default; can be increased up to published limits when using extended-output headers
    workflowRoles: ['generator', 'analyzer', 'agent'],
    workTypes: [
      'conversation',
      'content_creation',
      'data_analysis',
      'document_processing',
      'agent_orchestration',
    ],
    apiModelIds: {
      bedrock: {
        onDemand: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
        serverless: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      },
    },
    defaultInferenceType: 'serverless', // <-- explicitly defined
  },

  /** Amazon Nova Pro */
  'amazon.nova-pro-v1:0': {
    id: 'amazon.nova-pro-v1:0',
    displayName: 'Amazon Nova Pro',
    provider: 'amazon',
    description: 'Multimodal model optimized for accuracy and large-doc analysis.',
    version: 'Mar 2025',
    releaseDate: '2025-03-01',

    pricing: {
      type: 'token',
      inputCostPerUnit: 0.0008,
      outputCostPerUnit: 0.0032,
      unit: '1K tokens',
    },
    contextWindow: 300000,
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
    parameterSpecs: {
      temperature: { min: 0, max: 1, default: 0.7, step: 0.1 },
      topP: { min: 0, max: 1, default: 0.95 },
      maxTokens: { min: 1, max: 10000, default: 2000 },
    },
    apiConventions: {
      supportsFunctionCalling: true,
      supportsJSONMode: true,
      supportsStreaming: true,
    },
    tokenizer: {
      mode: 'approx',
      provider: 'amazon',
      estimationMethod: {
        charsPerToken: 4,
        overhead: 15,
      },
    },
    reservedOutputTokens: 10000, // aligns with published max output
    workflowRoles: ['generator', 'analyzer'],
    workTypes: [
      'conversation',
      'content_creation',
      'data_analysis',
      'document_processing',
    ],
    apiModelIds: {
      bedrock: {
        onDemand: 'amazon.nova-pro-v1:0',
        serverless: 'us.amazon.nova-pro-v1:0',
      },
    },
    defaultInferenceType: 'serverless', // <-- explicitly defined
  },

  /** Meta LLaMA 4 Maverick */
  'meta.llama4-maverick-17b-instruct-v1:0': {
    id: 'meta.llama4-maverick-17b-instruct-v1:0',
    displayName: 'LLaMA 4 Maverick',
    provider: 'meta',
    description: 'Multimodal reasoning model with 1M token context window.',
    version: 'Apr 2025',
    releaseDate: '2025-04-01',

    pricing: {
      type: 'token',
      inputCostPerUnit: 0.00027,
      outputCostPerUnit: 0.00085,
      unit: '1K tokens',
    },
    contextWindow: 1000000,
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
    parameterSpecs: {
      temperature: { min: 0, max: 1, default: 0.5, step: 0.1 },
      // Bedrock docs for Maverick emphasize context; explicit output max varies by platform.
      // We keep maxTokens param unspecified here to avoid implying a vendor-specific hard cap.
    },
    apiConventions: {
      supportsFunctionCalling: true,
      supportsJSONMode: true,
      supportsStreaming: true,
    },
    tokenizer: {
      mode: 'approx',
      provider: 'meta',
      estimationMethod: {
        charsPerToken: 4,
        overhead: 15,
      },
    },
    reservedOutputTokens: 8192, // conservative reserve; some providers document ~8k output caps
    workflowRoles: ['generator', 'analyzer', 'agent'],
    workTypes: [
      'conversation',
      'content_creation',
      'data_analysis',
      'document_processing',
    ],
    apiModelIds: {
      bedrock: {
        onDemand: 'meta.llama4-maverick-17b-instruct-v1:0',
        serverless: 'us.meta.llama4-maverick-17b-instruct-v1:0',
      },
    },
    defaultInferenceType: 'serverless', // <-- serverless only for Meta
  },
};

// =======================================
// Helper functions
// =======================================

export function getAllModels(): ModelCapability[] {
  return Object.values(MODEL_REGISTRY);
}

export function getModelsByProvider(provider: ModelProvider): ModelCapability[] {
  return Object.values(MODEL_REGISTRY).filter(
    (model) => model.provider === provider
  );
}

export function getModelById(id: string) {
  // Strip region prefix if present
  const normalizedId = id.replace(/^us\./, '');
  return MODEL_REGISTRY[normalizedId];
}

export function getModelsWithFeature(
  feature: keyof APIConventions
): ModelCapability[] {
  return Object.values(MODEL_REGISTRY).filter(
    (model) => model.apiConventions[feature] === true
  );
}

export function getModelsByWorkType(workType: WorkType): ModelCapability[] {
  return Object.values(MODEL_REGISTRY).filter((model) =>
    model.workTypes.includes(workType)
  );
}

export function getModelsByWorkflowRole(role: WorkflowRole): ModelCapability[] {
  return Object.values(MODEL_REGISTRY).filter((model) =>
    model.workflowRoles.includes(role)
  );
}

/**
 * Determines if a model ID refers to an AWS Bedrock model.
 */
export function isBedrockModel(modelId: string): boolean {
  const model = getModelById(modelId);
  return model?.provider === 'amazon' || model?.provider === 'anthropic' || model?.provider === 'meta';
}

/**
 * Provides default client config for the given model ID.
 */
export function getModelClientConfig(modelId: string): {
  apiModelId: string;
  temperature: number;
  maxTokens: number;
  region: string;
} {
  const model = getModelById(modelId);

  if (!model) {
    throw new Error(`Model ID '${modelId}' not found in registry`);
  }

  const apiModelId =
    model.apiModelIds?.default ??
    model.apiModelIds?.bedrock?.onDemand ??
    model.apiModelIds?.bedrock?.serverless;

  if (!apiModelId) {
    throw new Error(`No API model ID configured for model '${modelId}'`);
  }

  return {
    apiModelId,
    temperature: model.parameterSpecs.temperature?.default ?? 0.7,
    maxTokens: model.parameterSpecs.maxTokens?.default ?? 1000,
    region: process.env.AWS_REGION || 'us-east-1',
  };
}
