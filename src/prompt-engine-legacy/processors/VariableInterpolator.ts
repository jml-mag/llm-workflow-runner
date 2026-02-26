// amplify/functions/workflow-runner/src/prompt-engine/processors/VariableInterpolator.ts

import { Logger } from "@aws-lambda-powertools/logger";
import type { InterpolationContext, InterpolationPreview } from "../types";
import { validateTemplateInput, sanitizeValue } from "../utils/validation";

const logger = new Logger({ serviceName: "PromptEngine.VariableInterpolator" });

export class VariableInterpolator {
  private readonly SAFE_PATTERN = /\{\{([a-zA-Z0-9_.]+)\}\}/g;
  private readonly MAX_RECURSION_DEPTH = 3;

  /**
   * Interpolate variables in template with security validation
   */
  interpolate(template: string, context: InterpolationContext): string {
    const startTime = Date.now();

    logger.debug("Starting variable interpolation", {
      templateLength: template.length,
      contextKeys: Object.keys(context)
    });

    // Validate input
    const validation = validateTemplateInput(template, context);
    if (!validation.isValid) {
      logger.error("Template validation failed", {
        errors: validation.errors,
        warnings: validation.warnings
      });
      throw new Error(`Template validation failed: ${validation.errors.join(", ")}`);
    }

    if (validation.warnings.length > 0) {
      logger.warn("Template validation warnings", {
        warnings: validation.warnings
      });
    }

    // Use sanitized template
    let result = validation.sanitizedTemplate || template;
    let recursionDepth = 0;
    let variablesReplaced = 0;

    // Interpolate with recursion protection
    while (this.SAFE_PATTERN.test(result) && recursionDepth < this.MAX_RECURSION_DEPTH) {
      const beforeLength = result.length;
      result = result.replace(this.SAFE_PATTERN, (match, variablePath) => {
        const value = this.getVariableValue(variablePath, context);
        variablesReplaced++;
        
        logger.debug("Variable replaced", {
          variablePath,
          hasValue: value !== undefined,
          valueLength: typeof value === 'string' ? value.length : 0
        });

        return sanitizeValue(value);
      });

      // Break if no changes made
      if (result.length === beforeLength) break;
      recursionDepth++;
    }

    const processingTime = Date.now() - startTime;

    logger.info("Variable interpolation completed", {
      originalLength: template.length,
      finalLength: result.length,
      variablesReplaced,
      recursionDepth,
      processingTime
    });

    if (recursionDepth >= this.MAX_RECURSION_DEPTH) {
      logger.warn("Max recursion depth reached during interpolation", {
        maxDepth: this.MAX_RECURSION_DEPTH,
        variablesReplaced
      });
    }

    return result;
  }

  /**
   * Get variable value from context using dot notation
   */
  private getVariableValue(path: string, context: InterpolationContext): unknown {
    try {
      // Handle special context mappings
      const specialValue = this.getSpecialContextValue(path, context);
      if (specialValue !== undefined) {
        return specialValue;
      }

      // Navigate nested object path
      return this.getNestedValue(context, path);

    } catch (error) {
      logger.warn("Failed to get variable value", {
        path,
        error: error instanceof Error ? error.message : "Unknown error"
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
      case 'current.timestamp':
        return context.timestamp;
      case 'current.date':
        return new Date(context.timestamp).toISOString().split('T')[0];
      case 'current.time':
        return new Date(context.timestamp).toISOString().split('T')[1].split('.')[0];
      default:
        return undefined;
    }
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((current: unknown, key: string) => {
      if (current && typeof current === 'object' && current !== null) {
        const currentObj = current as Record<string, unknown>;
        return currentObj[key];
      }
      return undefined;
    }, obj as unknown);
  }

  /**
   * Extract all variable references from template
   */
  extractVariables(template: string): string[] {
    const variables: string[] = [];
    let match;
    
    while ((match = this.SAFE_PATTERN.exec(template)) !== null) {
      variables.push(match[1]);
    }
    
    // Reset regex lastIndex
    this.SAFE_PATTERN.lastIndex = 0;
    
    return [...new Set(variables)]; // Remove duplicates
  }

  /**
   * Check if template has any variables
   */
  hasVariables(template: string): boolean {
    return this.SAFE_PATTERN.test(template);
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

    variables.forEach(variablePath => {
      const value = this.getVariableValue(variablePath, context);
      preview.variableValues[variablePath] = value;
      
      if (value === undefined) {
        preview.missingVariables.push(variablePath);
        preview.hasAllVariables = false;
      }
    });

    return preview;
  }
}