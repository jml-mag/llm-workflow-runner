// amplify/functions/workflow-runner/src/prompt-engine/utils/validation.ts

import { Logger } from "@aws-lambda-powertools/logger";
import type { InterpolationContext, PromptSegment } from "../types";

const logger = new Logger({ serviceName: "PromptEngine.Validation" });

// Dangerous patterns that could indicate injection attempts
const INJECTION_PATTERNS = [
  /<!--.*?-->/g,              // HTML comments
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, // Script tags
  /javascript:/gi,            // JavaScript protocols
  /on\w+\s*=/gi,             // Event handlers
  /\${.*?}/g,                // Template literals
  /\[\[.*?\]\]/g,            // Double brackets (potential prompt injection)
  /\{\{.*?system.*?\}\}/gi,  // Attempts to override system prompts
  /ignore\s+previous\s+instructions/gi, // Common injection phrase
  /you\s+are\s+now/gi,       // Role override attempts
];

// Maximum sizes to prevent resource exhaustion
const LIMITS = {
  MAX_TEMPLATE_SIZE: 50000,    // 50KB max template
  MAX_VARIABLE_VALUE_SIZE: 10000, // 10KB max variable value
  MAX_INTERPOLATED_SIZE: 100000,  // 100KB max final result
  MAX_VARIABLE_DEPTH: 5,       // Max nested variable depth
  MAX_VARIABLES_PER_TEMPLATE: 100, // Max variable count
};

// Safe variable name pattern (alphanumeric, dots, underscores only)
const SAFE_VARIABLE_PATTERN = /^[a-zA-Z0-9_.]+$/;

/**
 * Comprehensive input validation for templates and variables
 */
export function validateTemplateInput(
  template: string,
  context: InterpolationContext
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic size checks
  if (template.length > LIMITS.MAX_TEMPLATE_SIZE) {
    errors.push(`Template exceeds maximum size (${LIMITS.MAX_TEMPLATE_SIZE} chars)`);
  }

  if (template.length === 0) {
    warnings.push("Empty template provided");
  }

  // Check for injection patterns
  const injectionResults = detectInjectionAttempts(template);
  if (injectionResults.length > 0) {
    errors.push(`Potential injection patterns detected: ${injectionResults.join(", ")}`);
  }

  // Validate variable references in template
  const variableValidation = validateVariableReferences(template, context);
  errors.push(...variableValidation.errors);
  warnings.push(...variableValidation.warnings);

  // Check context object
  const contextValidation = validateInterpolationContext(context);
  errors.push(...contextValidation.errors);
  warnings.push(...contextValidation.warnings);

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitizedTemplate: errors.length === 0 ? sanitizeTemplate(template) : template
  };
}

/**
 * Validate prompt segments for safety and consistency
 */
export function validatePromptSegments(segments: PromptSegment[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (segments.length === 0) {
    errors.push("No prompt segments provided");
    return { isValid: false, errors, warnings };
  }

  // Check segment structure and content
  segments.forEach((segment, index) => {
    if (!segment.role || !["system", "user", "assistant"].includes(segment.role)) {
      errors.push(`Invalid role "${segment.role}" at segment ${index}`);
    }

    if (typeof segment.content !== "string") {
      errors.push(`Non-string content at segment ${index}`);
    } else {
      // Check for injection attempts in content
      const injectionResults = detectInjectionAttempts(segment.content);
      if (injectionResults.length > 0) {
        warnings.push(`Potential injection in segment ${index}: ${injectionResults.join(", ")}`);
      }

      // Check for excessive size
      if (segment.content.length > LIMITS.MAX_INTERPOLATED_SIZE) {
        errors.push(`Segment ${index} exceeds maximum size`);
      }
    }
  });

  // Check segment order (system should come first)
  if (segments.length > 0 && segments[0].role !== "system") {
    warnings.push("First segment is not a system message");
  }

  // Check for consecutive segments with same role
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].role === segments[i - 1].role && segments[i].role !== "system") {
      warnings.push(`Consecutive ${segments[i].role} messages at segments ${i - 1} and ${i}`);
    }
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Detect potential prompt injection attempts
 */
function detectInjectionAttempts(content: string): string[] {
  const detected: string[] = [];

  INJECTION_PATTERNS.forEach((pattern) => {
    if (pattern.test(content)) {
      detected.push(pattern.toString());
    }
  });

  // Check for role override attempts
  if (/(?:^|\n)\s*(?:system|user|assistant)\s*:/gi.test(content)) {
    detected.push("role_override_attempt");
  }

  // Check for instruction termination attempts
  if (/(?:stop|end|ignore|forget)\s+(?:instructions|prompt|system)/gi.test(content)) {
    detected.push("instruction_termination");
  }

  return detected;
}

/**
 * Validate variable references in template
 */
function validateVariableReferences(
  template: string,
  context: InterpolationContext
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Extract all variable references
  const variableRefs = template.match(/\{\{([^}]+)\}\}/g) || [];

  if (variableRefs.length > LIMITS.MAX_VARIABLES_PER_TEMPLATE) {
    errors.push(`Too many variables (${variableRefs.length}), max ${LIMITS.MAX_VARIABLES_PER_TEMPLATE}`);
  }

  variableRefs.forEach((ref) => {
    const variablePath = ref.slice(2, -2).trim();

    // Check variable name safety
    if (!SAFE_VARIABLE_PATTERN.test(variablePath)) {
      errors.push(`Unsafe variable name: ${variablePath}`);
      return;
    }

    // Check variable depth
    const depth = variablePath.split('.').length;
    if (depth > LIMITS.MAX_VARIABLE_DEPTH) {
      errors.push(`Variable path too deep: ${variablePath} (max depth: ${LIMITS.MAX_VARIABLE_DEPTH})`);
    }

    // Check if variable exists in context
    const value = getNestedValue(context, variablePath);
    if (value === undefined) {
      warnings.push(`Variable not found in context: ${variablePath}`);
    } else if (typeof value === "string" && value.length > LIMITS.MAX_VARIABLE_VALUE_SIZE) {
      errors.push(`Variable value too large: ${variablePath}`);
    }
  });

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Validate interpolation context structure
 */
function validateInterpolationContext(context: InterpolationContext): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  const requiredFields = ['workflowId', 'conversationId', 'userId', 'timestamp'];
  requiredFields.forEach(field => {
    if (!context[field as keyof InterpolationContext]) {
      errors.push(`Missing required context field: ${field}`);
    }
  });

  // Validate field types and formats
  if (context.workflowId && typeof context.workflowId !== 'string') {
    errors.push("workflowId must be a string");
  }

  if (context.conversationId && typeof context.conversationId !== 'string') {
    errors.push("conversationId must be a string");
  }

  if (context.userId && typeof context.userId !== 'string') {
    errors.push("userId must be a string");
  }

  // Validate timestamp format
  if (context.timestamp) {
    const timestamp = new Date(context.timestamp);
    if (isNaN(timestamp.getTime())) {
      errors.push("Invalid timestamp format");
    }
  }

  // Validate slots object
  if (context.slots && typeof context.slots !== 'object') {
    errors.push("slots must be an object");
  } else if (context.slots) {
    Object.values(context.slots).forEach(value => {
      if (typeof value !== 'string') {
        warnings.push("Non-string value in slots object");
      }
    });
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Get nested value from object using dot notation path
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((current: unknown, key: string) => {
    if (current && typeof current === 'object' && current !== null) {
      const currentObj = current as Record<string, unknown>;
      return currentObj[key];
    }
    return undefined;
  }, obj as unknown);
}

/**
 * Basic template sanitization
 */
function sanitizeTemplate(template: string): string {
  // Remove potential HTML/script content
  return template
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<!--.*?-->/g, '')
    .replace(/javascript:/gi, '')
    .trim();
}

/**
 * Sanitize interpolated value
 */
export function sanitizeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let stringValue = String(value);

  // Limit size
  if (stringValue.length > LIMITS.MAX_VARIABLE_VALUE_SIZE) {
    logger.warn("Variable value truncated due to size", {
      originalLength: stringValue.length,
      maxLength: LIMITS.MAX_VARIABLE_VALUE_SIZE
    });
    stringValue = stringValue.substring(0, LIMITS.MAX_VARIABLE_VALUE_SIZE) + '...';
  }

  // Basic sanitization
  return stringValue
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[removed]')
    .replace(/javascript:/gi, '[removed]');
}

// Result interface for validation functions
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedTemplate?: string;
}