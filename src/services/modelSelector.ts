// amplify/functions/workflow-runner/src/services/modelSelector.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { ChatBedrockConverse } from "@langchain/aws";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getModelById } from "../modelCapabilities";

const logger = new Logger({ serviceName: "modelSelector" });

interface ModelClientParams {
  temperature: number;
  maxTokens: number;
  region: string;
  streaming?: boolean;
  inferenceType?: "onDemand" | "serverless";
}

/**
 * Creates a LangChain LLM client for the specified model ID
 * with the specified parameters
 */
export async function createModelClient(
  modelId: string,
  params: ModelClientParams
): Promise<BaseChatModel> {
  logger.info("Creating LangChain model client", { modelId, params });

  const model = getModelById(modelId);
  if (!model) {
    logger.warn(`Model ID '${modelId}' not found in registry. Falling back to default model.`);
    const defaultModelId = process.env.DEFAULT_MODEL_ID!;
    const defaultModel = getModelById(defaultModelId);
    if (!defaultModel) {
      throw new Error(`Default model ID '${defaultModelId}' not found in registry.`);
    }
    return createModelClient(defaultModelId, params);
  }

  const provider = model?.provider;

  if (provider === "openai") {
    return new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: modelId,              // ✅ FIXED: Added model parameter
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      streaming: params.streaming,
    });
  }

  if (provider === "anthropic" || provider === "amazon" || provider === "meta") {
    return new ChatBedrockConverse({
      region: params.region,
      model: modelId,              // ✅ Already correct - uses model: modelId
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      streaming: params.streaming,
    });
  }

  throw new Error(`Unsupported model provider: ${provider}`);
}