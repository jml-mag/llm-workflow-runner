// amplify/functions/workflow-runner/src/nodes/IntentClassifier.ts

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { State, NodeConfig } from "../types";
import type { Schema } from "../../../../data/resource";
import { createModelClient } from "../services/modelSelector";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { logProgressForOwners } from "../utils/progress";

const logger = new Logger({ serviceName: "IntentClassifier" });
const tracer = new Tracer({ serviceName: "IntentClassifier" });
const metrics = new Metrics({ serviceName: "IntentClassifier" });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

/**
 * IntentClassifier node configuration extending base NodeConfig
 */
interface IntentClassifierConfig extends NodeConfig {
  /** List of valid intents for classification */
  intents: string[];
  /** System prompt template for classification (use {{intents}} placeholder) */
  systemPrompt?: string;
  /** Model ID to use for classification */
  modelId?: string;
  /** Fallback intent when classification fails */
  fallbackIntent?: string;
  /** Whether to include confidence estimation */
  includeConfidence?: boolean;
  /** Minimum confidence threshold (0-1) */
  confidenceThreshold?: number;
}

/**
 * IntentClassifier Node Handler
 * 
 * Classifies user input into predefined intent categories using LLM.
 * Provides fallback handling and confidence scoring.
 * 
 * @param state - Current workflow state
 * @param dataClient - Amplify data client for database operations
 * @returns Updated state with classified intent
 */
export const handleIntentClassifier = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "IntentClassifier");
  tracer.putAnnotation("ConversationId", state.conversationId);
  
  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);
  
  logger.info("IntentClassifier node starting", {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    inputLength: state.userPrompt?.length || 0,
    hasInput: !!state.userPrompt?.trim()
  });

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "IntentClassifier",
    status: "STARTED",
    message: "Classifying intent…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Intent", 
        body: "Classifying…" 
      } 
    })
  });

  try {
    const config = state.currentNodeConfig as IntentClassifierConfig;
    
    // Validate configuration
    if (!config || !Array.isArray(config.intents) || config.intents.length === 0) {
      throw new Error("IntentClassifier requires intents configuration");
    }

    const {
      intents,
      systemPrompt = "You are an intent classifier. Classify the user's message into exactly one of these categories: {{intents}}. Respond with only the category name in lowercase, nothing else.",
      modelId = process.env.DEFAULT_MODEL_ID || "anthropic.claude-3-7-sonnet-20250219-v1:0",
      fallbackIntent = intents[0] || "other",
      includeConfidence = false,
      confidenceThreshold = 0.7
    } = config;

    const userInput = state.userPrompt?.trim();
    
    if (!userInput) {
      logger.warn("No user input provided for intent classification");
      
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "IntentClassifier",
        status: "COMPLETED",
        message: fallbackIntent,
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Intent", 
            items: [fallbackIntent, "(fallback)"] 
          },
          fallbackReason: "no_input",
          selectedIntent: fallbackIntent,
          availableIntents: intents
        })
      });

      return {
        intent: fallbackIntent,
        intentConfidence: includeConfidence ? 0 : undefined,
        modelResponse: `No input provided, using fallback intent: ${fallbackIntent}`,
        formattedResponse: `Intent classified as: ${fallbackIntent} (fallback)`
      };
    }

    // Normalize intents to lowercase for consistent matching
    const normalizedIntents = intents.map(intent => intent.toLowerCase());
    
    // Build classification prompt
    const prompt = systemPrompt.replace("{{intents}}", intents.join(", "));
    
    logger.info("Starting intent classification", {
      inputText: userInput.substring(0, 200) + (userInput.length > 200 ? "..." : ""),
      availableIntents: intents,
      modelId,
      includeConfidence
    });

    // Create model client optimized for classification
    const llm = await createModelClient(modelId, {
      temperature: 0.1, // Low temperature for consistent classification
      maxTokens: 50, // Short response needed
      region: process.env.AWS_REGION || "us-east-1",
      streaming: false // No streaming needed for classification
    });

    // Create classification prompt
    const promptTemplate = ChatPromptTemplate.fromMessages([
      ["system", prompt],
      ["user", userInput]
    ]);

    // Execute classification
    const startTime = Date.now();
    const response = await llm.invoke(await promptTemplate.format({}));
    const classificationTime = Date.now() - startTime;

    const rawResponse = response.content.toString().trim();
    const rawIntent = rawResponse.toLowerCase();
    
    logger.info("Raw classification response", {
      rawResponse,
      rawIntent,
      classificationTime,
      responseLength: rawResponse.length
    });

    // Validate intent is in allowed list
    let classifiedIntent = rawIntent;
    let confidence = 1.0;
    let usedFallback = false;
    let matchingStrategy = "exact_match";

    if (!normalizedIntents.includes(rawIntent)) {
      // Intent not in allowed list - try partial matching
      const partialMatch = normalizedIntents.find(intent => 
        rawIntent.includes(intent) || intent.includes(rawIntent)
      );

      if (partialMatch) {
        classifiedIntent = partialMatch;
        confidence = 0.8; // Lower confidence for partial match
        matchingStrategy = "partial_match";
        logger.info("Used partial intent matching", {
          rawIntent,
          matchedIntent: partialMatch
        });
      } else {
        // No match found - use fallback
        classifiedIntent = fallbackIntent.toLowerCase();
        confidence = 0.5; // Low confidence for fallback
        usedFallback = true;
        matchingStrategy = "fallback";
        
        logger.warn("Intent not in allowed list, using fallback", {
          rawIntent,
          rawResponse,
          allowedIntents: normalizedIntents,
          fallbackIntent: classifiedIntent
        });
      }
    }

    // Apply confidence threshold check
    if (includeConfidence && confidence < confidenceThreshold) {
      classifiedIntent = fallbackIntent.toLowerCase();
      usedFallback = true;
      matchingStrategy = "fallback";
      
      logger.info("Confidence below threshold, using fallback", {
        originalIntent: rawIntent,
        confidence,
        threshold: confidenceThreshold,
        fallbackIntent: classifiedIntent
      });
    }

    // Find original case intent for response
    const originalCaseIntent = intents.find(intent => 
      intent.toLowerCase() === classifiedIntent
    ) || classifiedIntent;

    logger.info("Intent classification completed", {
      finalIntent: originalCaseIntent,
      confidence,
      usedFallback,
      classificationTime
    });

    // Build UI items for chips display
    const uiItems = [originalCaseIntent];
    if (usedFallback) {
      uiItems.push("(fallback)");
    }
    if (includeConfidence) {
      uiItems.push(`${(confidence * 100).toFixed(0)}%`);
    }

    // 4. Emit COMPLETED with the chosen intent
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "IntentClassifier",
      status: "COMPLETED",
      message: originalCaseIntent,
      metadata: JSON.stringify({
        userVisible: true,
        ui: { 
          kind: "chips", 
          title: "Intent", 
          items: uiItems 
        },
        // Structured metadata for telemetry
        classifiedIntent: originalCaseIntent,
        confidence: includeConfidence ? confidence : undefined,
        usedFallback,
        rawResponse,
        classificationTime,
        modelId,
        availableIntents: intents,
        inputLength: userInput.length,
        classificationAnalysis: {
          inputPreview: userInput.substring(0, 100) + (userInput.length > 100 ? "..." : ""),
          normalizedIntents,
          matchingStrategy,
          confidenceThreshold: includeConfidence ? confidenceThreshold : undefined,
          belowThreshold: includeConfidence ? confidence < confidenceThreshold : false
        },
        modelConfiguration: {
          temperature: 0.1,
          maxTokens: 50,
          streaming: false,
          modelId
        },
        performanceMetrics: {
          classificationTime,
          responseLength: rawResponse.length,
          tokensUsed: Math.ceil(rawResponse.length / 4)
        }
      })
    });

    // Record metrics
    metrics.addMetric("IntentClassifications", MetricUnit.Count, 1);
    metrics.addMetric("ClassificationTime", MetricUnit.Milliseconds, classificationTime);
    
    if (usedFallback) {
      metrics.addMetric("FallbackIntentsUsed", MetricUnit.Count, 1);
    }

    if (includeConfidence) {
      metrics.addMetric("ClassificationConfidence", MetricUnit.Percent, confidence * 100);
    }

    // Build response message
    const responseMessage = usedFallback
      ? `Intent classified as: ${originalCaseIntent} (fallback)`
      : `Intent classified as: ${originalCaseIntent}`;

    const detailedMessage = includeConfidence
      ? `${responseMessage} (confidence: ${(confidence * 100).toFixed(1)}%)`
      : responseMessage;

    return {
      intent: originalCaseIntent,
      intentConfidence: includeConfidence ? confidence : undefined,
      modelResponse: `Intent: ${originalCaseIntent}`,
      formattedResponse: detailedMessage
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error in IntentClassifier';
    
    logger.error("IntentClassifier node failed", {
      error: errorMessage,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      inputLength: state.userPrompt?.length || 0
    });

    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "IntentClassifier",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        inputLength: state.userPrompt?.length || 0,
        configProvided: !!state.currentNodeConfig
      })
    });

    metrics.addMetric("IntentClassificationErrors", MetricUnit.Count, 1);
    
    throw error;
  }
};