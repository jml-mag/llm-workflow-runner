// amplify/functions/workflow-runner/src/prompt-engine/processors/Security.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

const logger = new Logger({ serviceName: "PromptEngine.Security" });
const metrics = new Metrics({ serviceName: "PromptEngine.Security" });

// PII detection patterns with high precision
const PII_PATTERNS = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  PHONE: /(\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
  SSN: /\b\d{3}-?\d{2}-?\d{4}\b/g,
  CREDIT_CARD: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  // Common patterns that may contain sensitive info
  API_KEY: /\b[A-Za-z0-9]{32,}\b/g,
  UUID: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Address patterns (simplified)
  POSTAL_CODE: /\b\d{5}(?:-\d{4})?\b/g,
} as const;

// Injection detection patterns
const INJECTION_PATTERNS = {
  HTML_SCRIPT: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  HTML_COMMENT: /<!--.*?-->/g,
  JAVASCRIPT_PROTOCOL: /javascript:/gi,
  EVENT_HANDLER: /on\w+\s*=/gi,
  TEMPLATE_LITERAL: /\${.*?}/g,
  DOUBLE_BRACKETS: /\[\[.*?\]\]/g,
  SYSTEM_OVERRIDE: /\{\{.*?system.*?\}\}/gi,
  IGNORE_INSTRUCTIONS: /ignore\s+previous\s+instructions/gi,
  ROLE_OVERRIDE: /you\s+are\s+now/gi,
  INSTRUCTION_TERMINATION: /(?:stop|end|ignore|forget)\s+(?:instructions|prompt|system)/gi,
} as const;

/**
 * Production-grade PII scrubber with detection and redaction
 */
export class PIIScrubber {
  private readonly replacementMap = new Map<keyof typeof PII_PATTERNS, string>([
    ['EMAIL', '[EMAIL_REDACTED]'],
    ['PHONE', '[PHONE_REDACTED]'],
    ['SSN', '[SSN_REDACTED]'],
    ['CREDIT_CARD', '[CARD_REDACTED]'],
    ['API_KEY', '[API_KEY_REDACTED]'],
    ['UUID', '[UUID_REDACTED]'],
    ['POSTAL_CODE', '[ZIP_REDACTED]'],
  ]);

  /**
   * Detect presence of PII without modifying content
   */
  detectPII(content: string): boolean {
    if (!content || typeof content !== 'string') {
      return false;
    }

    for (const [patternName, pattern] of Object.entries(PII_PATTERNS)) {
      if (pattern.test(content)) {
        logger.debug("PII detected", { 
          patternType: patternName,
          contentLength: content.length 
        });
        
        metrics.addMetric(`PII_${patternName}_Detected`, MetricUnit.Count, 1);
        return true;
      }
    }

    return false;
  }

  /**
   * Scrub PII from content with detailed logging
   */
  scrubContent(content: string): string {
    if (!content || typeof content !== 'string') {
      return content || '';
    }

    let scrubbed = content;
    let totalReplacements = 0;

    for (const [patternName, pattern] of Object.entries(PII_PATTERNS)) {
      const replacement = this.replacementMap.get(patternName as keyof typeof PII_PATTERNS) || '[REDACTED]';
      
      const matches = scrubbed.match(pattern);
      if (matches && matches.length > 0) {
        scrubbed = scrubbed.replace(pattern, replacement);
        totalReplacements += matches.length;
        
        logger.info("PII scrubbed from content", {
          patternType: patternName,
          matchCount: matches.length,
          replacement
        });
        
        metrics.addMetric(`PII_${patternName}_Scrubbed`, MetricUnit.Count, matches.length);
      }
    }

    if (totalReplacements > 0) {
      logger.info("PII scrubbing completed", {
        originalLength: content.length,
        scrubbedLength: scrubbed.length,
        totalReplacements
      });

      metrics.addMetric('PII_Total_Replacements', MetricUnit.Count, totalReplacements);
    }

    return scrubbed;
  }

  /**
   * More aggressive scrubbing for logs (truncates long content)
   */
  scrubForLogs(content: string, maxLength: number = 200): string {
    const scrubbed = this.scrubContent(content);
    
    if (scrubbed.length > maxLength) {
      return scrubbed.substring(0, maxLength) + '[...TRUNCATED_FOR_LOGS]';
    }
    
    return scrubbed;
  }

  /**
   * Detect potential prompt injection attempts
   */
  detectInjection(content: string): Array<{ type: string; detected: boolean; pattern: string }> {
    const results: Array<{ type: string; detected: boolean; pattern: string }> = [];

    for (const [patternName, pattern] of Object.entries(INJECTION_PATTERNS)) {
      const detected = pattern.test(content);
      
      results.push({
        type: patternName,
        detected,
        pattern: pattern.toString()
      });

      if (detected) {
        logger.warn("Potential injection detected", {
          patternType: patternName,
          contentLength: content.length
        });
        
        metrics.addMetric(`Injection_${patternName}_Detected`, MetricUnit.Count, 1);
      }
    }

    return results;
  }

  /**
   * Basic content sanitization (remove dangerous patterns)
   */
  sanitizeContent(content: string): string {
    let sanitized = content;

    // Remove script tags and comments
    sanitized = sanitized
      .replace(INJECTION_PATTERNS.HTML_SCRIPT, '[SCRIPT_REMOVED]')
      .replace(INJECTION_PATTERNS.HTML_COMMENT, '')
      .replace(INJECTION_PATTERNS.JAVASCRIPT_PROTOCOL, '[JS_PROTOCOL_REMOVED]');

    // Normalize excessive whitespace
    sanitized = sanitized
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{3,}/g, '  ')
      .trim();

    if (sanitized !== content) {
      logger.info("Content sanitized", {
        originalLength: content.length,
        sanitizedLength: sanitized.length
      });

      metrics.addMetric('Content_Sanitized', MetricUnit.Count, 1);
    }

    return sanitized;
  }
}

/**
 * Secure logger that automatically scrubs PII from all log output
 */
export class SecureLogger {
  private readonly piiScrubber = new PIIScrubber();

  /**
   * Log info with automatic PII scrubbing
   */
  info(message: string, data: Record<string, unknown>, correlationId: string): void {
    const scrubbedData = this.scrubLogData(data);
    
    logger.info(message, {
      ...scrubbedData,
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log warning with automatic PII scrubbing
   */
  warn(message: string, data: Record<string, unknown>, correlationId: string): void {
    const scrubbedData = this.scrubLogData(data);
    
    logger.warn(message, {
      ...scrubbedData,
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log error with automatic PII scrubbing
   */
  error(message: string, data: Record<string, unknown>, correlationId: string): void {
    const scrubbedData = this.scrubLogData(data);
    
    logger.error(message, {
      ...scrubbedData,
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log debug with automatic PII scrubbing
   */
  debug(message: string, data: Record<string, unknown>, correlationId: string): void {
    const scrubbedData = this.scrubLogData(data);
    
    logger.debug(message, {
      ...scrubbedData,
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Recursively scrub PII from log data objects
   */
  private scrubLogData(data: Record<string, unknown>): Record<string, unknown> {
    const scrubbed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        scrubbed[key] = this.piiScrubber.scrubForLogs(value);
      } else if (Array.isArray(value)) {
        scrubbed[key] = value.map(item => 
          typeof item === 'string' ? this.piiScrubber.scrubForLogs(item) : item
        );
      } else if (value && typeof value === 'object') {
        scrubbed[key] = this.scrubLogData(value as Record<string, unknown>);
      } else {
        scrubbed[key] = value;
      }
    }

    return scrubbed;
  }
}

/**
 * Content validation with security checks
 */
export class ContentValidator {
  private readonly piiScrubber = new PIIScrubber();

  /**
   * Comprehensive content validation
   */
  validateContent(content: string): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    sanitized: string;
    piiDetected: boolean;
    injectionRisks: Array<{ type: string; detected: boolean }>;
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation
    if (!content || typeof content !== 'string') {
      errors.push('Content must be a non-empty string');
      return {
        isValid: false,
        errors,
        warnings,
        sanitized: '',
        piiDetected: false,
        injectionRisks: []
      };
    }

    // Size validation
    if (content.length > 500000) { // 500KB limit
      errors.push('Content exceeds maximum size limit (500KB)');
    } else if (content.length > 300000) { // 300KB warning
      warnings.push('Content size approaching limit - will be stored in S3');
    }

    // PII detection
    const piiDetected = this.piiScrubber.detectPII(content);
    if (piiDetected) {
      warnings.push('PII detected in content - will be scrubbed');
    }

    // Injection detection
    const injectionRisks = this.piiScrubber.detectInjection(content);
    const hasInjectionRisk = injectionRisks.some(risk => risk.detected);
    
    if (hasInjectionRisk) {
      warnings.push('Potential injection patterns detected');
    }

    // Unicode validation
    try {
      const normalized = content.normalize('NFC');
      if (normalized.length !== content.length) {
        warnings.push('Content contains complex Unicode characters');
      }
    } catch {
      errors.push('Content contains invalid Unicode sequences');
    }

    // Content sanitization
    const sanitized = this.piiScrubber.sanitizeContent(content);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitized,
      piiDetected,
      injectionRisks: injectionRisks.map(risk => ({ type: risk.type, detected: risk.detected }))
    };
  }
}