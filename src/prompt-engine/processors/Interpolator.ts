// amplify/functions/workflow-runner/src/prompt-engine/processors/Interpolator.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

const logger = new Logger({ serviceName: "PromptEngine.Interpolator" });
const metrics = new Metrics({ serviceName: "PromptEngine.Interpolator" });

export interface InterpolationContext {
  workflowState: Record<string, unknown>; // Fixed: remove any type
  workflowId: string;
  conversationId: string;
  userId: string;
  nodeId: string;
  nodeType: string;
  slots: Record<string, string>;
  intent: string;
  timestamp: string;
  correlationId: string;
  model: {
    id: string;
    provider: string;
    displayName: string;
  };
  [key: string]: unknown; // Allow additional properties
}

export interface InterpolationPreview {
  variablesFound: string[];
  variableValues: Record<string, unknown>;
  missingVariables: string[];
  hasAllVariables: boolean;
}

// Security limits to prevent resource exhaustion
const LIMITS = {
  MAX_TEMPLATE_SIZE: 500000,        // 500KB max template
  MAX_VARIABLE_VALUE_SIZE: 50000,   // 50KB max variable value
  MAX_INTERPOLATED_SIZE: 1000000,   // 1MB max final result
  MAX_VARIABLE_DEPTH: 5,            // Max nested variable depth
  MAX_VARIABLES_PER_TEMPLATE: 100,  // Max variable count
  MAX_RECURSION_DEPTH: 3,           // Max recursive interpolation
};

// Safe variable name pattern (alphanumeric, dots, underscores only)
const SAFE_VARIABLE_PATTERN = /^[a-zA-Z0-9_.]+$/;

// Variable interpolation pattern
const VARIABLE_PATTERN = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

/**
 * Secure variable interpolator with injection protection and resource limits
 */
export class Interpolator {
  /**
   * Interpolate variables in template with comprehensive security validation
   */
  interpolate(template: string, context: InterpolationContext): string {
    const startTime = Date.now();

    logger.debug("Starting variable interpolation", {
      templateLength: template.length,
      contextKeys: Object.keys(context).length,
      correlationId: context.correlationId
    });

    // Input validation
    const validation = this.validateInput(template, context);
    if (!validation.isValid) {
      throw new InterpolationError(
        'VALIDATION_FAILED',
        `Template validation failed: ${validation.errors.join(", ")}`,
        { errors: validation.errors, warnings: validation.warnings }
      );
    }

    if (validation.warnings.length > 0) {
      logger.warn("Template validation warnings", {
        warnings: validation.warnings,
        correlationId: context.correlationId
      });
    }

    let result = template;
    let recursionDepth = 0;
    let totalReplacements = 0;

    // Interpolate with recursion protection
    while (VARIABLE_PATTERN.test(result) && recursionDepth < LIMITS.MAX_RECURSION_DEPTH) {
      const beforeLength = result.length;

      result = result.replace(VARIABLE_PATTERN, (match, variablePath) => {
        const value = this.getVariableValue(variablePath, context);
        const sanitizedValue = this.sanitizeValue(value);
        
        totalReplacements++;
        
        logger.debug("Variable replaced", {
          variablePath,
          hasValue: value !== undefined,
          valueLength: typeof sanitizedValue === 'string' ? sanitizedValue.length : 0,
          correlationId: context.correlationId
        });

        return sanitizedValue;
      });

      // Break if no changes made or size limit exceeded
      if (result.length === beforeLength) break;
      
      if (result.length > LIMITS.MAX_INTERPOLATED_SIZE) {
        throw new InterpolationError(
          'SIZE_LIMIT_EXCEEDED',
          `Interpolated result exceeds maximum size (${LIMITS.MAX_INTERPOLATED_SIZE} chars)`,
          { resultSize: result.length, limit: LIMITS.MAX_INTERPOLATED_SIZE }
        );
      }

      recursionDepth++;
      
      // Reset pattern for next iteration
      VARIABLE_PATTERN.lastIndex = 0;
    }

    const processingTime = Date.now() - startTime;

    // Record metrics
    metrics.addMetric('VariableInterpolation', MetricUnit.Count, 1);
    metrics.addMetric('InterpolationLatency', MetricUnit.Milliseconds, processingTime);
    metrics.addMetric('VariablesReplaced', MetricUnit.Count, totalReplacements);

    if (recursionDepth >= LIMITS.MAX_RECURSION_DEPTH) {
      logger.warn("Max recursion depth reached during interpolation", {
        maxDepth: LIMITS.MAX_RECURSION_DEPTH,
        totalReplacements,
        correlationId: context.correlationId
      });
      
      metrics.addMetric('InterpolationRecursionLimitHit', MetricUnit.Count, 1);
    }

    logger.info("Variable interpolation completed", {
      originalLength: template.length,
      finalLength: result.length,
      totalReplacements,
      recursionDepth,
      processingTime,
      correlationId: context.correlationId
    });

    return result;
  }

  /**
   * Extract all variable references from template
   */
  extractVariables(template: string): string[] {
    const variables: string[] = [];
    let match;
    
    // Reset pattern
    VARIABLE_PATTERN.lastIndex = 0;
    
    while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
      variables.push(match[1]);
    }
    
    // Remove duplicates
    return Array.from(new Set(variables));
  }

  /**
   * Check if template has any variables
   */
  hasVariables(template: string): boolean {
    VARIABLE_PATTERN.lastIndex = 0;
    return VARIABLE_PATTERN.test(template);
  }

  /**
   * Preview interpolation results without full processing
   */
  previewInterpolation(template: string, context: InterpolationContext): InterpolationPreview {
    const variables = this.extractVariables(template);
    const preview: InterpolationPreview = {
      variablesFound: variables,
      variableValues: {},
      missingVariables: [],
      hasAllVariables: true
    };

    for (const variablePath of variables) {
      const value = this.getVariableValue(variablePath, context);
      preview.variableValues[variablePath] = value;
      
      if (value === undefined) {
        preview.missingVariables.push(variablePath);
        preview.hasAllVariables = false;
      }
    }

    return preview;
  }

  /**
   * Get variable value from context using dot notation
   */
  private getVariableValue(path: string, context: InterpolationContext): unknown {
    try {
      // Handle special context mappings for convenience
      const specialValue = this.getSpecialContextValue(path, context);
      if (specialValue !== undefined) {
        return specialValue;
      }

      // Navigate nested object path
      return this.getNestedValue(context, path);

    } catch (error) {
      logger.warn("Failed to get variable value", {
        path,
        error: error instanceof Error ? error.message : "Unknown error",
        correlationId: context.correlationId
      });
      return undefined;
    }
  }

  /**
   * Handle special context mappings for convenience
   */
  private getSpecialContextValue(path: string, context: InterpolationContext): unknown {
    switch (path) {
      case 'user.id':
        return context.userId;
      case 'workflow.id':
        return context.workflowId;
      case 'conversation.id':
        return context.conversationId;
      case 'node.id':
        return context.nodeId;
      case 'node.type':
        return context.nodeType;
      case 'model.name':
        return context.model.displayName;
      case 'model.provider':
        return context.model.provider;
      case 'model.id':
        return context.model.id;
      case 'current.timestamp':
        return context.timestamp;
      case 'current.date':
        return new Date(context.timestamp).toISOString().split('T')[0];
      case 'current.time':
        return new Date(context.timestamp).toISOString().split('T')[1].split('.')[0];
      case 'current.iso':
        return context.timestamp;
      case 'intent':
        return context.intent;
      case 'correlation.id':
        return context.correlationId;
      default:
        return undefined;
    }
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const keys = path.split('.');
    
    if (keys.length > LIMITS.MAX_VARIABLE_DEPTH) {
      throw new InterpolationError(
        'VARIABLE_DEPTH_EXCEEDED',
        `Variable path too deep: ${path} (max depth: ${LIMITS.MAX_VARIABLE_DEPTH})`,
        { path, depth: keys.length, maxDepth: LIMITS.MAX_VARIABLE_DEPTH }
      );
    }

    return keys.reduce((current: unknown, key: string) => {
      if (current && typeof current === 'object' && current !== null) {
        const currentObj = current as Record<string, unknown>;
        return currentObj[key];
      }
      return undefined;
    }, obj as unknown);
  }

  /**
   * Validate input template and context
   */
  private validateInput(template: string, context: InterpolationContext): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic size checks
    if (template.length > LIMITS.MAX_TEMPLATE_SIZE) {
      errors.push(`Template exceeds maximum size (${LIMITS.MAX_TEMPLATE_SIZE} chars)`);
    }

    if (template.length === 0) {
      warnings.push("Empty template provided");
    }

    // Extract and validate variables
    const variables = this.extractVariables(template);
    
    if (variables.length > LIMITS.MAX_VARIABLES_PER_TEMPLATE) {
      errors.push(`Too many variables (${variables.length}), max ${LIMITS.MAX_VARIABLES_PER_TEMPLATE}`);
    }

    for (const variablePath of variables) {
      // Check variable name safety
      if (!SAFE_VARIABLE_PATTERN.test(variablePath)) {
        errors.push(`Unsafe variable name: ${variablePath}`);
        continue;
      }

      // Check variable depth
      const depth = variablePath.split('.').length;
      if (depth > LIMITS.MAX_VARIABLE_DEPTH) {
        errors.push(`Variable path too deep: ${variablePath} (max depth: ${LIMITS.MAX_VARIABLE_DEPTH})`);
      }

      // Check if variable exists in context
      const value = this.getVariableValue(variablePath, context);
      if (value === undefined) {
        warnings.push(`Variable not found in context: ${variablePath}`);
      } else if (typeof value === "string" && value.length > LIMITS.MAX_VARIABLE_VALUE_SIZE) {
        errors.push(`Variable value too large: ${variablePath} (${value.length} chars)`);
      }
    }

    // Validate context structure
    const requiredFields = ['workflowId', 'conversationId', 'userId', 'timestamp'];
    for (const field of requiredFields) {
      if (!context[field]) {
        warnings.push(`Missing recommended context field: ${field}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Sanitize interpolated value to prevent injection
   */
  private sanitizeValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    let stringValue = String(value);

    // Limit size to prevent memory issues
    if (stringValue.length > LIMITS.MAX_VARIABLE_VALUE_SIZE) {
      logger.warn("Variable value truncated due to size", {
        originalLength: stringValue.length,
        maxLength: LIMITS.MAX_VARIABLE_VALUE_SIZE
      });
      
      stringValue = stringValue.substring(0, LIMITS.MAX_VARIABLE_VALUE_SIZE) + '[...TRUNCATED]';
      
      metrics.addMetric('VariableValueTruncated', MetricUnit.Count, 1);
    }

    // Basic sanitization to remove potentially dangerous content
    stringValue = stringValue
      // Remove script tags
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[SCRIPT_REMOVED]')
      // Remove HTML comments
      .replace(/<!--.*?-->/g, '')
      // Remove javascript: protocols
      .replace(/javascript:/gi, '[JS_PROTOCOL_REMOVED]')
      // Remove event handlers
      .replace(/on\w+\s*=/gi, '[EVENT_HANDLER_REMOVED]');

    return stringValue;
  }
}

/**
 * Structured error for interpolation failures
 */
export class InterpolationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'InterpolationError';
  }
}