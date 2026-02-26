// amplify/functions/workflow-runner/src/nodes/Format.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { State } from "../types";
import type { Schema } from "@platform/data/resource";
import { LLMResponseWrapper } from "@platform/utils/LLMResponseWrapper";
import { logProgressForOwners } from "../utils/progress";

// Ensure explicit service name to avoid 'service_undefined' logs
const logger = new Logger({ serviceName: 'Format' });
const tracer = new Tracer({ serviceName: 'Format' });
const metrics = new Metrics({ serviceName: 'Format' });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

export const handleFormat = async (
  state: State & { ownersForProgress?: string[] }, 
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "Format");
  logger.info("Node: Format — dynamic formatting");

  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "Format",
    status: "STARTED",
    message: "Formatting…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Format", 
        body: "Formatting…" 
      } 
    })
  });

  try {
    // Extract configuration with defaults
    const config = state.currentNodeConfig || {};
    let outputFormat = config.outputFormat || 'markdown';
    const customName = config.name || 'Format Output';

    // ✅ NORMALIZATION: Convert legacy 'plain' to 'text' (with type casting to handle legacy values)
    const rawFormat = outputFormat as string;
    if (rawFormat === 'plain') {
      outputFormat = 'text';
      logger.info("Normalized legacy 'plain' format to 'text'");
    }

    console.log(`🎨 Using format configuration:`);
    console.log(`   Output Format: ${outputFormat}`);
    console.log(`   Node Name: ${customName}`);

    let formatted = state.modelResponse || "";
    const originalLength = formatted.length;

    // Track interpolated keys for debugging
    const interpolatedKeys: string[] = [];

    // 3. Do the work - apply formatting
    switch (outputFormat) {
      case 'markdown':
        // Add markdown formatting
        formatted = `## 🤖 AI Response\n\n${formatted}`;
        interpolatedKeys.push('markdown_header');
        break;
        
      case 'text':
        // Plain text - no special formatting
        formatted = formatted;
        break;
        
      case 'json':
        // Wrap in JSON structure
        formatted = JSON.stringify({
          response: formatted,
          timestamp: new Date().toISOString(),
          nodeId: state.currentNodeId,
          workflowId: state.workflowId
        }, null, 2);
        interpolatedKeys.push('timestamp', 'nodeId', 'workflowId');
        break;
        
      default:
        // Default: add emoji prefix
        formatted = `🤖 ${formatted}`;
        interpolatedKeys.push('emoji_prefix');
    }

    console.log(`✅ Applied ${outputFormat} formatting`);
    console.log(`📏 Formatted length: ${formatted.length} characters`);

    // ✅ NEW: Use LLMResponseWrapper.validateStructure for format checks
    const expected = outputFormat as 'json'|'text'|'markdown' | undefined;
    const validation = LLMResponseWrapper.validateStructure(formatted, expected);
    
    if (validation.errors.length > 0) {
      // If validation errors, log them and continue
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "Format",
        status: "ERROR",
        message: `Failed: Format validation failed`,
        metadata: JSON.stringify({ 
          errors: validation.errors, 
          warnings: validation.warnings,
          outputFormat,
          formattedLength: formatted.length
        })
      });
      
      throw new Error(`Format validation failed: ${validation.errors.join(', ')}`);
    }

    // Log warnings if present
    const warningsMetadata = validation.warnings.length > 0 ? {
      warnings: validation.warnings,
      validationPassed: true,
      hasWarnings: true
    } : {
      validationPassed: true,
      hasWarnings: false
    };

    // 4. Emit COMPLETED with a small snippet
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "Format", 
      status: "COMPLETED",
      message: "Formatting done",
      metadata: JSON.stringify({
        userVisible: true,
        ui: { 
          kind: "snippet", 
          title: "Format", 
          plain: "Formatting done" 
        },
        // Structured metadata for telemetry
        outputFormat,
        originalLength,
        formattedLength: formatted.length,
        nodeName: customName,
        formatApplied: outputFormat !== 'text',
        interpolatedKeys,
        lengthIncrease: formatted.length - originalLength,
        formattingRatio: originalLength > 0 ? (formatted.length / originalLength).toFixed(2) : "N/A",
        normalizedFromPlain: rawFormat === 'plain',
        ownersCount: owners.length,
        dualWriteEnabled: owners.length > 1,
        ...warningsMetadata
      })
    });

    metrics.addMetric("FormatCalls", MetricUnit.Count, 1);
    metrics.addMetric("FormattedLength", MetricUnit.Count, formatted.length);

    logger.info("Format node completed", {
      outputFormat,
      originalLength,
      formattedLength: formatted.length,
      nodeName: customName,
      ownersCount: owners.length,
      hasWarnings: validation.warnings.length > 0
    });

    return { formattedResponse: formatted };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error in Format';
    
    logger.error("Format node failed", {
      error: errorMessage,
      workflowId: state.workflowId,
      conversationId: state.conversationId
    });

    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "Format",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        inputLength: (state.modelResponse || "").length,
        configProvided: !!state.currentNodeConfig
      })
    });

    metrics.addMetric("FormatErrors", MetricUnit.Count, 1);
    
    throw error;
  }
};