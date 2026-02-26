// amplify/functions/workflow-runner/src/prompt-engine/processors/MessageFormatter.ts
import { BaseMessage, SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

const logger = new Logger({ serviceName: "PromptEngine.MessageFormatter" });
const metrics = new Metrics({ serviceName: "PromptEngine.MessageFormatter" });

export interface PromptSegment {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

interface FormattingStats {
  totalSegments: number;
  roleCount: {
    system: number;
    user: number;
    assistant: number;
  };
  totalCharacters: number;
  averageLength: number;
  longestSegment: number;
  shortestSegment: number;
}

interface UnknownSegment {
  role: string;
  content: string;
}

/**
 * Message formatter that converts prompt segments to LangChain BaseMessage array
 * with comprehensive validation and error handling
 */
export class MessageFormatter {
  /**
   * Convert prompt segments to LangChain BaseMessage array
   * LangChain handles provider normalization automatically
   */
  formatMessages(segments: PromptSegment[]): BaseMessage[] {
    const startTime = Date.now();

    logger.debug("Formatting messages for LangChain", {
      segmentCount: segments.length
    });

    // Validate input segments
    const validation = this.validateSegments(segments);
    if (!validation.isValid) {
      throw new MessageFormatterError(
        'VALIDATION_FAILED',
        `Segment validation failed: ${validation.errors.join(", ")}`,
        { errors: validation.errors, warnings: validation.warnings }
      );
    }

    if (validation.warnings.length > 0) {
      logger.warn("Segment validation warnings", {
        warnings: validation.warnings
      });
    }

    try {
      const messages = segments.map((segment, index) => {
        try {
          switch (segment.role) {
            case "system":
              return new SystemMessage(segment.content);
            case "user":
              return new HumanMessage(segment.content);
            case "assistant":
              return new AIMessage(segment.content);
            default:
              // Fixed: Properly type the unknown segment
              const unknownSegment = segment as UnknownSegment;
              throw new MessageFormatterError(
                'INVALID_ROLE',
                `Unknown message role: ${unknownSegment.role}`,
                { role: unknownSegment.role, index, contentLength: segment.content?.length }
              );
          }
        } catch (error) {
          logger.error("Failed to create message", {
            index,
            role: segment.role,
            contentLength: segment.content?.length || 0,
            error: error instanceof Error ? error.message : "Unknown error"
          });
          throw error;
        }
      });

      const processingTime = Date.now() - startTime;

      // Record metrics
      metrics.addMetric('MessagesFormatted', MetricUnit.Count, 1);
      metrics.addMetric('MessageFormattingLatency', MetricUnit.Milliseconds, processingTime);
      metrics.addMetric('MessageCount', MetricUnit.Count, messages.length);

      // Record role distribution
      const roleCount = this.calculateRoleCounts(segments);
      Object.entries(roleCount).forEach(([role, count]) => {
        metrics.addMetric(`${role}Messages`, MetricUnit.Count, count);
      });

      logger.info("Messages formatted successfully", {
        inputSegments: segments.length,
        outputMessages: messages.length,
        processingTime,
        roleDistribution: roleCount
      });

      return messages;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      metrics.addMetric('MessageFormattingFailure', MetricUnit.Count, 1);
      
      logger.error("Message formatting failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        segmentCount: segments.length,
        processingTime
      });
      throw error;
    }
  }

  /**
   * Validate message structure before formatting
   */
  validateSegments(segments: PromptSegment[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!segments || !Array.isArray(segments)) {
      errors.push("Segments must be a non-empty array");
      return { isValid: false, errors, warnings };
    }

    if (segments.length === 0) {
      errors.push("No segments provided for formatting");
      return { isValid: false, errors, warnings };
    }

    segments.forEach((segment, index) => {
      // Check required properties
      if (!segment || typeof segment !== 'object') {
        errors.push(`Segment ${index} must be an object`);
        return;
      }

      if (!segment.role) {
        errors.push(`Missing role at segment ${index}`);
      } else if (!["system", "user", "assistant"].includes(segment.role)) {
        errors.push(`Invalid role "${segment.role}" at segment ${index}`);
      }

      if (segment.content === undefined || segment.content === null) {
        errors.push(`Missing content at segment ${index}`);
      } else if (typeof segment.content !== "string") {
        errors.push(`Non-string content at segment ${index} (type: ${typeof segment.content})`);
      } else {
        // Content-specific validations
        if (segment.content.trim().length === 0) {
          warnings.push(`Empty content at segment ${index} (role: ${segment.role})`);
        }

        if (segment.content.length > 100000) { // 100KB warning threshold
          warnings.push(`Very long content at segment ${index} (${segment.content.length} chars, role: ${segment.role})`);
        }

        // Check for potential encoding issues
        try {
          // Test if content can be properly encoded
          JSON.stringify(segment.content);
        } catch (encError) {
          errors.push(`Content encoding issue at segment ${index}: ${encError instanceof Error ? encError.message : 'Unknown encoding error'}`);
        }
      }
    });

    // Structural validations
    this.validateMessageFlow(segments, warnings);

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate logical message flow and structure
   */
  private validateMessageFlow(segments: PromptSegment[], warnings: string[]): void {
    // Check if first segment is system message
    if (segments.length > 0 && segments[0].role !== "system") {
      warnings.push("First segment is not a system message - this may affect model behavior");
    }

    // Check for multiple system messages
    const systemMessages = segments.filter(s => s.role === "system");
    if (systemMessages.length > 1) {
      warnings.push(`Multiple system messages found (${systemMessages.length}) - only first may be used by some providers`);
    }

    // Check for consecutive segments with same role (except system)
    for (let i = 1; i < segments.length; i++) {
      const current = segments[i];
      const previous = segments[i - 1];
      
      if (current.role === previous.role && current.role !== "system") {
        warnings.push(`Consecutive ${current.role} messages at segments ${i-1} and ${i} - may indicate conversation flow issues`);
      }
    }

    // Check for reasonable conversation structure
    const nonSystemSegments = segments.filter(s => s.role !== "system");
    const userMessages = nonSystemSegments.filter(s => s.role === "user").length;
    const assistantMessages = nonSystemSegments.filter(s => s.role === "assistant").length;

    if (userMessages === 0) {
      warnings.push("No user messages found - conversation may not have user input");
    }

    if (assistantMessages > userMessages) {
      warnings.push("More assistant messages than user messages - unusual conversation structure");
    }

    // Check if conversation ends with user message (typical for completion)
    if (nonSystemSegments.length > 0 && nonSystemSegments[nonSystemSegments.length - 1].role !== "user") {
      warnings.push("Conversation does not end with user message - may not generate completion");
    }
  }

  /**
   * Calculate role distribution statistics
   */
  private calculateRoleCounts(segments: PromptSegment[]): { system: number; user: number; assistant: number } {
    return {
      system: segments.filter(s => s.role === "system").length,
      user: segments.filter(s => s.role === "user").length,
      assistant: segments.filter(s => s.role === "assistant").length
    };
  }

  /**
   * Get formatting statistics for monitoring and debugging
   */
  getFormattingStats(segments: PromptSegment[]): FormattingStats {
    if (!segments || segments.length === 0) {
      return {
        totalSegments: 0,
        roleCount: { system: 0, user: 0, assistant: 0 },
        totalCharacters: 0,
        averageLength: 0,
        longestSegment: 0,
        shortestSegment: 0
      };
    }

    const roleCount = this.calculateRoleCounts(segments);
    const segmentLengths = segments.map(s => s.content?.length || 0);
    const totalCharacters = segmentLengths.reduce((sum, length) => sum + length, 0);
    const averageLength = Math.round(totalCharacters / segments.length);

    return {
      totalSegments: segments.length,
      roleCount,
      totalCharacters,
      averageLength,
      longestSegment: Math.max(...segmentLengths, 0),
      shortestSegment: segments.length > 0 ? Math.min(...segmentLengths) : 0
    };
  }

  /**
   * Convert LangChain messages back to prompt segments (utility function)
   */
  messagesToSegments(messages: BaseMessage[]): PromptSegment[] {
    return messages.map(message => ({
      role: this.langChainTypeToRole(message._getType()),
      content: message.content as string
    }));
  }

  /**
   * Map LangChain message types to prompt segment roles
   */
  private langChainTypeToRole(messageType: string): "system" | "user" | "assistant" {
    switch (messageType) {
      case "system":
        return "system";
      case "human":
        return "user";
      case "ai":
        return "assistant";
      default:
        logger.warn("Unknown LangChain message type, defaulting to user", {
          messageType
        });
        return "user";
    }
  }

  /**
   * Sanitize segments before formatting (removes potentially problematic content)
   */
  sanitizeSegments(segments: PromptSegment[]): PromptSegment[] {
    return segments.map(segment => ({
      ...segment,
      content: this.sanitizeContent(segment.content)
    }));
  }

  /**
   * Basic content sanitization
   */
  private sanitizeContent(content: string): string {
    if (typeof content !== 'string') {
      return String(content || '');
    }

    return content
      // Normalize whitespace
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Remove null bytes and control characters (except newlines and tabs)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Trim excessive whitespace
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/ {4,}/g, '   ');
  }
}

/**
 * Structured error for message formatting failures
 */
export class MessageFormatterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MessageFormatterError';
  }
}