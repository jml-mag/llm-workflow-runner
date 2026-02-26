// amplify/functions/workflow-runner/src/nodes/SlotTracker.ts

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { State, NodeConfig } from "../types";
import type { Schema } from "../../../../data/resource";
import { logProgressForOwners } from "../utils/progress";
// ✅ NEW: Import slot state utilities
import { saveSlotState, clearSlotState } from "../utils/slotState";

const logger = new Logger({ serviceName: "SlotTracker" });
const tracer = new Tracer({ serviceName: "SlotTracker" });
const metrics = new Metrics({ serviceName: "SlotTracker" });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

// ────────────────────────────────────────────────────────────────────────────────
// Helpers: light normalization so synthesis has cleaner inputs
// ────────────────────────────────────────────────────────────────────────────────
function normalizeGoal(raw: string | undefined): string {
  if (!raw) return "(unspecified)";
  const s = raw.toLowerCase();
  if (/(don't|dont)\s+know|not\s+sure|no\s+idea|what\s+do\s+you\s+mean|\bi\b\s+don'?t\s+understand/.test(s)) {
    return "(unspecified)";
  }
  return raw;
}

function normalizeTimeline(raw: string | undefined): string {
  if (!raw) return "(unspecified)";
  const s = raw.toLowerCase().trim();
  if (/^soon$|^fast$|^asap$/.test(s)) return "0-2 weeks";
  return raw;
}

function inferHasStack(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase().trim();
  if (/^y(es)?$|^yeah$|^yep$|have|already|we\s+do/.test(s)) return true;
  if (/^n(o)?$|^nope$|^nah$|^none$/.test(s)) return false;
  return undefined;
}

/**
 * Configuration for individual slot collection
 */
interface SlotConfig {
  /** Unique identifier for this slot */
  key: string;
  /** Question to ask the user when collecting this slot */
  prompt: string;
  /** Whether this slot is required to complete the workflow */
  required: boolean;
  /** Optional regex pattern for validation */
  validation?: string;
  /** Human-readable description of expected format */
  validationHint?: string;
  /** Maximum number of retry attempts for invalid input */
  maxRetries?: number;
}

/**
 * SlotTracker node configuration extending base NodeConfig
 */
interface SlotTrackerConfig extends NodeConfig {
  /** Array of slots to collect from the user */
  slots: SlotConfig[];
  /** Whether to allow partial completion (skip optional slots) */
  allowPartial?: boolean;
  /** Whether to persist collected values to database */
  persistToState?: boolean;
  /** Maximum total attempts across all slots before giving up */
  maxTotalAttempts?: number;
  /** Route to take when max attempts exceeded */
  fallbackRoute?: string;
}

/**
 * SlotTracker Node Handler
 * 
 * Collects structured user input conversationally with validation.
 * Supports regex validation, retry logic, and persistent storage.
 * 
 * @param state - Current workflow state
 * @param dataClient - Amplify data client for database operations
 * @returns Updated state with slot values and completion status
 */
export const handleSlotTracker = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<Partial<State>> => {
  tracer.putAnnotation("Node", "SlotTracker");
  tracer.putAnnotation("ConversationId", state.conversationId);
  
  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);
  
  logger.info("SlotTracker node starting", {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    currentSlotKey: state.currentSlotKey,
    hasUserInput: !!state.userPrompt
  });

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "SlotTracker",
    status: "STARTED",
    message: "Collecting required info…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Collect", 
        body: "Checking required fields…" 
      } 
    })
  });

  try {
    const config = state.currentNodeConfig as SlotTrackerConfig;
    
    // Validate configuration
    if (!config || !Array.isArray(config.slots) || config.slots.length === 0) {
      throw new Error("SlotTracker requires slots configuration");
    }

    const {
      slots,
      allowPartial = false,
      persistToState = true,
      maxTotalAttempts = 10,
      fallbackRoute
    } = config;

    // Initialize or get current slot values (handle undefined properly)
    const currentValues = state.slotValues ? { ...state.slotValues } : {};
    const attemptCounts = state.slotAttempts ? { ...state.slotAttempts } : {};

    logger.info("SlotTracker configuration", {
      totalSlots: slots.length,
      requiredSlots: slots.filter(s => s.required).length,
      allowPartial,
      persistToState,
      currentValuesCount: Object.keys(currentValues).length
    });

    // 3. Do the work - collect and validate slots
    // If we have user input and are currently collecting a slot
    if (state.currentSlotKey && state.userPrompt?.trim()) {
      const currentSlot = slots.find(slot => slot.key === state.currentSlotKey);
      
      if (currentSlot) {
        const userInput = state.userPrompt.trim();
        let isValid = true;
        let validationError = "";

        // Validate input if validation pattern exists
        if (currentSlot.validation) {
          try {
            const regex = new RegExp(currentSlot.validation);
            isValid = regex.test(userInput);
            
            if (!isValid) {
              validationError = currentSlot.validationHint || 
                `Input doesn't match required format for ${currentSlot.key}`;
            }
          } catch (regexError) {
            logger.error("Invalid regex pattern", {
              slotKey: currentSlot.key,
              pattern: currentSlot.validation,
              error: regexError
            });
            // Allow input through if regex is malformed
            isValid = true;
          }
        }

        // Track attempt count
        const currentAttempts = (attemptCounts[state.currentSlotKey] || 0) + 1;
        attemptCounts[state.currentSlotKey] = currentAttempts;

        const maxRetries = currentSlot.maxRetries || 3;
        const totalAttempts = Object.values(attemptCounts).reduce((sum, count) => sum + count, 0);

        if (!isValid) {
          // Validation failed
          if (currentAttempts >= maxRetries || totalAttempts >= maxTotalAttempts) {
            // Max attempts exceeded
            logger.warn("Max validation attempts exceeded", {
              slotKey: state.currentSlotKey,
              attempts: currentAttempts,
              maxRetries,
              totalAttempts,
              maxTotalAttempts
            });

            if (fallbackRoute) {
              await logProgressForOwners(dataClient, owners, {
                workflowId: state.workflowId,
                conversationId: state.conversationId,
                stepName: "SlotTracker",
                status: "ERROR",
                message: `Failed: Validation failed too many times`,
                metadata: JSON.stringify({
                  reason: "max_attempts_exceeded",
                  slotKey: state.currentSlotKey,
                  attempts: currentAttempts,
                  maxRetries,
                  totalAttempts,
                  fallbackRoute
                })
              });

              metrics.addMetric("SlotValidationExceeded", MetricUnit.Count, 1);

              return {
                nextNode: fallbackRoute,
                slotAttempts: attemptCounts,
                modelResponse: "Too many invalid attempts. Let me try a different approach.",
                formattedResponse: "I'm having trouble with that format. Let me help you differently.",
                // CRITICAL: clear consumed prompt so we don't re-validate the same text on next invocation
                userPrompt: undefined,
              };
            } else {
              throw new Error(`Validation failed for slot '${currentSlot.key}' after ${currentAttempts} attempts`);
            }
          }

          // Re-prompt with error message
          const retryMessage = `${validationError}. ${currentSlot.prompt} (Attempt ${currentAttempts}/${maxRetries})`;

          await logProgressForOwners(dataClient, owners, {
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            stepName: "SlotTracker",
            status: "AWAITING_INPUT",
            message: retryMessage,
            metadata: JSON.stringify({
              userVisible: true, // ✅ Make retry prompts visible
              role: 'assistant',
              ui: {
                kind: 'snippet',
                title: 'Validation Error',
                plain: retryMessage
              },
              slotKey: state.currentSlotKey,
              attempts: currentAttempts,
              maxRetries,
              validationError,
              userInput: userInput.substring(0, 100) // Truncated for privacy
            })
          });

          metrics.addMetric("SlotValidationFailed", MetricUnit.Count, 1);

          logger.info("Slot validation failed, re-prompting", {
            slotKey: state.currentSlotKey,
            attempts: currentAttempts,
            maxRetries,
            validationError
          });

          // ✅ Save state before returning
          await saveSlotState(dataClient, state.conversationId, {
            slotValues: currentValues,
            slotAttempts: attemptCounts,
            currentSlotKey: state.currentSlotKey,
            allSlotsFilled: false,
          });

          return {
            slotValues: currentValues,
            slotAttempts: attemptCounts,
            currentSlotKey: state.currentSlotKey,
            allSlotsFilled: false,
            __needsUserInput: true,
            awaitingInputFor: state.currentSlotKey,
            modelResponse: retryMessage,
            formattedResponse: retryMessage,
            // CRITICAL: clear consumed prompt so we don't re-validate the same text on next invocation
            userPrompt: undefined,
          };
        }

        // Validation passed - store the value
        currentValues[state.currentSlotKey] = userInput;
        
        logger.info("Slot value captured successfully", {
          slotKey: state.currentSlotKey,
          valueLength: userInput.length,
          attempts: currentAttempts
        });

        metrics.addMetric("SlotsCaptured", MetricUnit.Count, 1);
      }
    }

    // Find next required slot that needs to be filled
    const unfilledSlots = slots.filter(slot => {
      const hasValue = currentValues[slot.key] && currentValues[slot.key].trim();
      return slot.required && !hasValue;
    });

    const nextSlot = unfilledSlots[0];

    if (nextSlot && !allowPartial) {
      // Still need to collect more required slots
      const promptMessage = `${nextSlot.prompt}${nextSlot.validationHint ? ` (${nextSlot.validationHint})` : ''}`;

      // ✅ Save state for resume BEFORE returning to await input
      await saveSlotState(dataClient, state.conversationId, {
        slotValues: currentValues,
        slotAttempts: attemptCounts,
        currentSlotKey: nextSlot.key,
        allSlotsFilled: false,
      });

      // ✅ FIXED: Add userVisible and ui metadata for chat rendering
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "SlotTracker",
        status: "AWAITING_INPUT",
        message: promptMessage,
        metadata: JSON.stringify({
          userVisible: true, // ✅ Make this visible in chat
          role: 'assistant',  // ✅ Mark as assistant message
          ui: {
            kind: 'snippet',
            title: 'Question',
            plain: promptMessage // ✅ The actual question text
          },
          // Structured metadata for telemetry
          nextSlotKey: nextSlot.key,
          remainingSlots: unfilledSlots.length,
          filledSlots: Object.keys(currentValues).length,
          totalSlots: slots.length
        })
      });

      metrics.addMetric("SlotPrompts", MetricUnit.Count, 1);

      logger.info("Prompting for next slot", {
        slotKey: nextSlot.key,
        remainingSlots: unfilledSlots.length,
        filledSlots: Object.keys(currentValues).length
      });

      return {
        slotValues: currentValues,
        slotAttempts: attemptCounts,
        currentSlotKey: nextSlot.key,
        allSlotsFilled: false,
        __needsUserInput: true,
        awaitingInputFor: nextSlot.key,
        modelResponse: promptMessage,
        formattedResponse: promptMessage,
        // CRITICAL: clear the consumed reply so next invocation doesn't re-consume it
        userPrompt: undefined,
      };
    }

    // All required slots are filled
    const filledSlotCount = Object.keys(currentValues).length;
    const requiredSlotCount = slots.filter(s => s.required).length;

    logger.info("Slot collection completed", {
      filledSlots: filledSlotCount,
      requiredSlots: requiredSlotCount,
      totalSlots: slots.length,
      collectedValues: Object.keys(currentValues)
    });

    // Persist to database if configured
    if (persistToState && filledSlotCount > 0) {
      try {
        // Write slot persistence record for each owner (dual-write)
        await Promise.all(owners.map(async (owner) =>
          dataClient.models.Memory.create({
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            role: "assistant",
            content: `Slot collection completed: ${JSON.stringify(currentValues, null, 2)}`,
            timestamp: new Date().toISOString(),
            owner, // Use owner field for dual-write
          })
        ));

        logger.info("Slot values persisted to database", {
          slotCount: filledSlotCount,
          ownersCount: owners.length
        });

        metrics.addMetric("SlotsPersisted", MetricUnit.Count, filledSlotCount);
      } catch (persistError) {
        logger.error("Failed to persist slot values", {
          error: persistError,
          slotCount: filledSlotCount
        });
        // Continue execution even if persistence fails
      }
    }

    // Send completion message to client
    const completionMessage = `Slots filled: ${filledSlotCount}/${requiredSlotCount}`;

    // 4. Emit COMPLETED with counts
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "SlotTracker",
      status: "COMPLETED",
      message: completionMessage,
      metadata: JSON.stringify({
        userVisible: true,
        ui: { 
          kind: "chips", 
          title: "Slots", 
          items: [`Filled: ${filledSlotCount}`, `Required: ${requiredSlotCount}`] 
        },
        // Structured metadata for telemetry
        filledSlots: filledSlotCount,
        requiredSlots: requiredSlotCount,
        totalSlots: slots.length,
        collectedSlotKeys: Object.keys(currentValues),
        allowPartial,
        persistToState,
        allRequiredFilled: filledSlotCount >= requiredSlotCount
      })
    });

    // ✅ Clear persisted slotState now that collection is complete
    await clearSlotState(dataClient, state.conversationId);

    // ✅ Build a flat, normalized payload for the next node ({{input}})
    const normalizedSlots = {
      role: currentValues.role ?? "",
      project: currentValues.project ?? "",
      goal: normalizeGoal(currentValues.goal),
      timeline: normalizeTimeline(currentValues.timeline),
      tech: currentValues.tech ?? "",
      hasStack: inferHasStack(currentValues.tech),
      contact: currentValues.contact ?? ""
    };

    // ✅ Seed next node with a user-first JSON message to guarantee user-start
    const synthesisUserSeed = `SYNTHESIZE\n${JSON.stringify(normalizedSlots)}`;

    logger.info("Seeding synthesis with collected slots", {
      payloadLength: synthesisUserSeed.length,
      slotKeys: Object.keys(normalizedSlots)
    });

    metrics.addMetric("SlotCollectionCompleted", MetricUnit.Count, 1);
    metrics.addMetric("TotalSlotsCollected", MetricUnit.Count, filledSlotCount);

    return {
      slotValues: currentValues,
      slotAttempts: attemptCounts,
      currentSlotKey: "", // Clear current slot
      awaitingInputFor: undefined,
      allSlotsFilled: true,
      // Make the normalized map available to {{input}} directly
      input: normalizedSlots,
      modelResponse: allowPartial && filledSlotCount < slots.length
        ? `Collected ${filledSlotCount} of ${slots.length} requested details. Proceeding with available information.`
        : `All required information collected successfully. ${filledSlotCount} details captured.`,
      formattedResponse: allowPartial && filledSlotCount < slots.length
        ? `Collected ${filledSlotCount} of ${slots.length} requested details. Proceeding with available information.`
        : `All required information collected successfully. ${filledSlotCount} details captured.`,
      // Important: ensure next node has a user-first message (JSON payload for {{input}})
      userPrompt: synthesisUserSeed,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error in SlotTracker';
    
    logger.error("SlotTracker node failed", {
      error: errorMessage,
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      currentSlotKey: state.currentSlotKey
    });

    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "SlotTracker",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        currentSlotKey: state.currentSlotKey,
        filledSlots: Object.keys(state.slotValues || {}).length,
        configProvided: !!state.currentNodeConfig
      })
    });

    metrics.addMetric("SlotTrackerErrors", MetricUnit.Count, 1);
    
    throw error;
  }
};