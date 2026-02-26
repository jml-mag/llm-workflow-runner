// amplify/functions/workflow-runner/src/prompt-engine/processors/MessageFormatter.ts

import { BaseMessage, SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { Logger } from "@aws-lambda-powertools/logger";
import type { PromptSegment } from "../types";

const messageLogger = new Logger({ serviceName: "PromptEngine.MessageFormatter" });

export class MessageFormatter {
  /**
   * Convert prompt segments to LangChain BaseMessage array
   * LangChain handles provider normalization automatically
   */
  formatMessages(segments: PromptSegment[]): BaseMessage[] {
    const startTime = Date.now();

    messageLogger.debug("Formatting messages for LangChain", {
      segmentCount: segments.length
    });

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
              messageLogger.error("Unknown message role", {
                role: segment.role,
                index,
                contentLength: segment.content.length
              });
              throw new Error(`Unknown role: ${segment.role}`);
          }
        } catch (error) {
          messageLogger.error("Failed to create message", {
            index,
            role: segment.role,
            contentLength: segment.content.length,
            error: error instanceof Error ? error.message : "Unknown error"
          });
          throw error;
        }
      });

      const processingTime = Date.now() - startTime;

      messageLogger.info("Messages formatted successfully", {
        inputSegments: segments.length,
        outputMessages: messages.length,
        processingTime
      });

      return messages;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      messageLogger.error("Message formatting failed", {
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

    if (segments.length === 0) {
      errors.push("No segments provided for formatting");
      return { isValid: false, errors, warnings };
    }

    segments.forEach((segment, index) => {
      // Check required properties
      if (!segment.role) {
        errors.push(`Missing role at segment ${index}`);
      } else if (!["system", "user", "assistant"].includes(segment.role)) {
        errors.push(`Invalid role "${segment.role}" at segment ${index}`);
      }

      if (segment.content === undefined || segment.content === null) {
        errors.push(`Missing content at segment ${index}`);
      } else if (typeof segment.content !== "string") {
        errors.push(`Non-string content at segment ${index}`);
      } else if (segment.content.trim().length === 0) {
        warnings.push(`Empty content at segment ${index}`);
      }

      // Check for excessively long content
      if (typeof segment.content === "string" && segment.content.length > 50000) {
        warnings.push(`Very long content at segment ${index} (${segment.content.length} chars)`);
      }
    });

    // Check message flow
    if (segments.length > 0 && segments[0].role !== "system") {
      warnings.push("First segment is not a system message");
    }

    // Check for alternating user/assistant pattern (after system)
    const nonSystemSegments = segments.filter(s => s.role !== "system");
    for (let i = 1; i < nonSystemSegments.length; i++) {
      if (nonSystemSegments[i].role === nonSystemSegments[i-1].role) {
        warnings.push(`Consecutive ${nonSystemSegments[i].role} messages detected`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get formatting statistics
   */
  getFormattingStats(segments: PromptSegment[]): FormattingStats {
    const roleCount = {
      system: segments.filter(s => s.role === "system").length,
      user: segments.filter(s => s.role === "user").length,
      assistant: segments.filter(s => s.role === "assistant").length
    };

    const totalLength = segments.reduce((sum, s) => sum + s.content.length, 0);
    const averageLength = segments.length > 0 ? Math.round(totalLength / segments.length) : 0;

    return {
      totalSegments: segments.length,
      roleCount,
      totalCharacters: totalLength,
      averageLength,
      longestSegment: Math.max(...segments.map(s => s.content.length), 0),
      shortestSegment: segments.length > 0 ? Math.min(...segments.map(s => s.content.length)) : 0
    };
  }
}

// Supporting interfaces
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