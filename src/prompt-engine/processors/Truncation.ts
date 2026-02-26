// amplify/functions/workflow-runner/src/prompt-engine/processors/Truncation.ts
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "PromptEngine.Truncation" });

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface TruncationResult {
  preservedTurns: ConversationTurn[];
  droppedTurns: ConversationTurn[];
  finalTokenCount: number;
  truncated: boolean;
}

/**
 * Unicode-safe conversation memory truncation
 * Handles multi-byte characters, emoji, and combining characters correctly
 */
export class UnicodeSafeTruncation {
  /**
   * Truncate conversation memory to fit within token budget
   * Strategy: Always preserve latest turn, remove oldest turns first
   */
  truncateToTokenBudget(memory: ConversationTurn[], tokenBudget: number): TruncationResult {
    if (memory.length === 0) {
      return {
        preservedTurns: [],
        droppedTurns: [],
        finalTokenCount: 0,
        truncated: false
      };
    }

    logger.debug("Starting memory truncation", {
      memoryTurns: memory.length,
      tokenBudget
    });

    let totalTokens = 0;
    const preservedTurns: ConversationTurn[] = [];
    const droppedTurns: ConversationTurn[] = [];

    // Always preserve the latest turn if possible
    if (memory.length > 0) {
      const latestTurn = memory[memory.length - 1];
      const latestTokens = this.countTokensSafely(latestTurn.content);
      
      if (latestTokens <= tokenBudget) {
        preservedTurns.push(latestTurn);
        totalTokens += latestTokens;
        
        logger.debug("Preserved latest turn", {
          role: latestTurn.role,
          tokens: latestTokens,
          contentLength: latestTurn.content.length
        });
      }
    }

    // Work backwards from second-to-last turn
    for (let i = memory.length - 2; i >= 0; i--) {
      const turn = memory[i];
      const turnTokens = this.countTokensSafely(turn.content);
      
      if (totalTokens + turnTokens <= tokenBudget) {
        preservedTurns.unshift(turn); // Add to beginning to maintain order
        totalTokens += turnTokens;
        
        logger.debug("Preserved memory turn", {
          index: i,
          role: turn.role,
          tokens: turnTokens,
          totalTokens
        });
      } else {
        droppedTurns.unshift(turn); // Add to beginning to maintain order
        
        logger.debug("Dropped memory turn", {
          index: i,
          role: turn.role,
          tokens: turnTokens,
          reason: 'exceeds_budget'
        });
      }
    }

    const wasTruncated = droppedTurns.length > 0;

    logger.info("Memory truncation completed", {
      originalTurns: memory.length,
      preservedTurns: preservedTurns.length,
      droppedTurns: droppedTurns.length,
      finalTokenCount: totalTokens,
      tokenBudget,
      truncated: wasTruncated
    });

    return {
      preservedTurns,
      droppedTurns,
      finalTokenCount: totalTokens,
      truncated: wasTruncated
    };
  }

  /**
   * Count tokens with proper Unicode handling
   */
  countTokensSafely(content: string): number {
    if (!content || typeof content !== 'string') {
      return 0;
    }

    try {
      // Normalize Unicode to handle combining characters
      const normalizedContent = content.normalize('NFC');
      
      // Check for normalization changes
      if (normalizedContent.length !== content.length) {
        logger.debug("Unicode normalization applied", {
          originalLength: content.length,
          normalizedLength: normalizedContent.length
        });
      }

      return this.approximateTokenCount(normalizedContent);
      
    } catch {
      logger.warn("Unicode normalization failed, using original content", {
        contentLength: content.length
      });
      
      return this.approximateTokenCount(content);
    }
  }

  /**
   * Approximate token count using grapheme clusters for better Unicode support
   */
  private approximateTokenCount(text: string): number {
    try {
      // Use Intl.Segmenter for proper grapheme cluster counting (visible characters)
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
        const segments = Array.from(segmenter.segment(text));
        
        // Approximate based on grapheme clusters rather than raw characters
        // This handles emoji and combining characters correctly
        const graphemeCount = segments.length;
        const approximateTokens = Math.ceil(graphemeCount / 3.5); // Adjusted for Unicode safety
        
        logger.debug("Token estimation with grapheme clusters", {
          rawLength: text.length,
          graphemeCount,
          approximateTokens
        });
        
        return Math.max(approximateTokens, 1); // Minimum 1 token for non-empty content
      }
    } catch (error) {
      logger.debug("Grapheme segmentation failed, falling back to character count", {
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }

    // Fallback to character-based estimation
    return this.fallbackTokenEstimation(text);
  }

  /**
   * Fallback token estimation for environments without Intl.Segmenter
   */
  private fallbackTokenEstimation(text: string): number {
    // Handle common multi-byte scenarios
    
    // Count emoji sequences (rough approximation)
    const emojiCount = (text.match(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/gu) || []).length;
    
    // Count CJK characters (Chinese, Japanese, Korean)
    const cjkCount = (text.match(/[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}]/gu) || []).length;
    
    // Remaining characters after accounting for emoji and CJK
    const remainingLength = Math.max(0, text.length - (emojiCount * 2) - (cjkCount * 2));
    
    // Token estimation: emoji ~1 token each, CJK ~1 token each, other chars ~4 chars per token
    const emojiTokens = emojiCount;
    const cjkTokens = cjkCount;
    const remainingTokens = Math.ceil(remainingLength / 4);
    
    const totalTokens = emojiTokens + cjkTokens + remainingTokens;
    
    logger.debug("Fallback token estimation", {
      textLength: text.length,
      emojiCount,
      cjkCount,
      remainingLength,
      totalTokens
    });
    
    return Math.max(totalTokens, 1); // Minimum 1 token for non-empty content
  }

  /**
   * Intelligent string truncation at safe Unicode boundaries
   */
  truncateStringAtBoundary(content: string, maxTokens: number): string {
    if (!content || maxTokens <= 0) {
      return '';
    }

    const currentTokens = this.countTokensSafely(content);
    if (currentTokens <= maxTokens) {
      return content;
    }

    // Estimate characters needed for target tokens
    const targetCharRatio = content.length / currentTokens;
    const targetChars = Math.floor(maxTokens * targetCharRatio * 0.9); // 90% to be safe

    if (targetChars >= content.length) {
      return content;
    }

    try {
      // Try to truncate at sentence boundaries
      const sentences = content.split(/[.!?]+/);
      let result = '';
      
      for (const sentence of sentences) {
        const potential = result + sentence + '.';
        if (this.countTokensSafely(potential) > maxTokens) {
          break;
        }
        result = potential;
      }

      if (result.length > 50) { // Minimum meaningful length
        return result.trim() + '...';
      }

      // Fall back to word boundaries
      const words = content.split(/\s+/);
      result = '';
      
      for (const word of words) {
        const potential = result + ' ' + word;
        if (this.countTokensSafely(potential) > maxTokens) {
          break;
        }
        result = potential;
      }

      if (result.length > 20) {
        return result.trim() + '...';
      }

      // Last resort: character truncation at safe Unicode boundaries
      return this.truncateAtUnicodeBoundary(content, targetChars) + '...';

    } catch (error) {
      logger.warn("Intelligent truncation failed, using simple truncation", {
        error: error instanceof Error ? error.message : "Unknown error",
        contentLength: content.length,
        targetChars
      });
      
      return this.truncateAtUnicodeBoundary(content, targetChars) + '...';
    }
  }

  /**
   * Truncate at safe Unicode boundary to avoid breaking multi-byte characters
   */
  private truncateAtUnicodeBoundary(text: string, maxLength: number): string {
    if (maxLength >= text.length) {
      return text;
    }

    // Simple approach: find the nearest valid character boundary
    let truncateAt = maxLength;
    
    // Move backwards to find a safe truncation point
    while (truncateAt > 0) {
      try {
        const candidate = text.substring(0, truncateAt);
        // Test if the substring contains valid Unicode
        candidate.normalize('NFC');
        
        // Check if we're in the middle of a surrogate pair
        const charCode = text.charCodeAt(truncateAt - 1);
        if (charCode >= 0xD800 && charCode <= 0xDBFF) {
          // High surrogate, move back one more character
          truncateAt--;
          continue;
        }
        
        return candidate;
      } catch {
        // Move back and try again
        truncateAt--;
      }
    }

    // Fallback: return empty string if we can't find a safe boundary
    return '';
  }
}