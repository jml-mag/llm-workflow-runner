// amplify/functions/workflow-runner/src/nodes/Router.ts

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { State, NodeConfig } from "../types";
import type { Schema } from "../../../../data/resource";
import { logProgressForOwners } from "../utils/progress";

const logger = new Logger({ serviceName: "Router" });
const tracer = new Tracer({ serviceName: "Router" });
const metrics = new Metrics({ serviceName: "Router" });

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

/**
 * Route condition configuration
 */
interface RouteCondition {
  /** Condition expression to evaluate */
  condition: string;
  /** Target node to route to when condition matches */
  target: string;
  /** Human-readable description of this route */
  description?: string;
  /** Priority order (lower numbers evaluated first) */
  priority?: number;
}

/**
 * Router node configuration extending base NodeConfig
 */
interface RouterConfig extends NodeConfig {
  /** Array of route conditions to evaluate */
  routes: RouteCondition[];
  /** Default route when no conditions match */
  defaultRoute?: string;
  /** Whether to log detailed routing decisions */
  enableDetailedLogging?: boolean;
  /** Whether to evaluate all conditions or stop at first match */
  evaluateAllConditions?: boolean;
}

/**
 * Route evaluation result
 */
interface RouteEvaluationResult {
  condition: string;
  target: string;
  matches: boolean;
  description?: string;
  priority?: number;
}

/**
 * Router result with chosen target for scheduler filtering
 */
interface RouterResult extends Partial<State> {
  __routeChosen?: string;
}

/**
 * Safe condition evaluator - NO eval() usage for security
 * Supports common routing patterns with type safety
 */
function evaluateCondition(condition: string, state: State): boolean {
  try {
    const normalizedCondition = condition.trim().toLowerCase();

    // Intent-based routing: intent === "value"
    const intentMatch = normalizedCondition.match(/intent\s*===\s*['"']([^'"']+)['"']/);
    if (intentMatch) {
      const expectedIntent = intentMatch[1];
      const actualIntent = state.intent?.toLowerCase();
      return actualIntent === expectedIntent;
    }

    // Intent contains pattern: intent.includes("value")
    const intentIncludesMatch = normalizedCondition.match(/intent\.includes\(['"']([^'"']+)['"']\)/);
    if (intentIncludesMatch) {
      const searchTerm = intentIncludesMatch[1];
      return state.intent?.toLowerCase().includes(searchTerm) || false;
    }

    // Slot completion routing: allSlotsFilled === true/false
    const slotFilledMatch = normalizedCondition.match(/allslotsfilled\s*===\s*(true|false)/);
    if (slotFilledMatch) {
      const expectedValue = slotFilledMatch[1] === 'true';
      return state.allSlotsFilled === expectedValue;
    }

    // Specific slot value routing: slotValues.key === "value"
    const slotValueMatch = normalizedCondition.match(/slotvalues\.(\w+)\s*===\s*['"']([^'"']+)['"']/);
    if (slotValueMatch) {
      const [, slotKey, expectedValue] = slotValueMatch;
      const actualValue = state.slotValues?.[slotKey];
      return actualValue === expectedValue;
    }

    // Slot existence check: slotValues.key !== undefined
    const slotExistsMatch = normalizedCondition.match(/slotvalues\.(\w+)\s*!==\s*undefined/);
    if (slotExistsMatch) {
      const slotKey = slotExistsMatch[1];
      const slotValue = state.slotValues?.[slotKey];
      return slotValue !== undefined && slotValue !== null && slotValue.trim() !== '';
    }

    // User prompt keyword check: userPrompt.includes("keyword")
    const promptIncludesMatch = normalizedCondition.match(/userprompt\.includes\(['"']([^'"']+)['"']\)/);
    if (promptIncludesMatch) {
      const keyword = promptIncludesMatch[1];
      return state.userPrompt?.toLowerCase().includes(keyword) || false;
    }

    // User prompt exact match: userPrompt === "value"
    const promptExactMatch = normalizedCondition.match(/userprompt\s*===\s*['"']([^'"']+)['"']/);
    if (promptExactMatch) {
      const expectedPrompt = promptExactMatch[1];
      return state.userPrompt?.toLowerCase() === expectedPrompt;
    }

    // Memory length check: memory.length > number
    const memoryLengthMatch = normalizedCondition.match(/memory\.length\s*([><=]+)\s*(\d+)/);
    if (memoryLengthMatch) {
      const [, operator, numberStr] = memoryLengthMatch;
      const targetLength = parseInt(numberStr, 10);
      const actualLength = state.memory?.length || 0;
      
      switch (operator) {
        case '>': return actualLength > targetLength;
        case '>=': return actualLength >= targetLength;
        case '<': return actualLength < targetLength;
        case '<=': return actualLength <= targetLength;
        case '==': 
        case '===': return actualLength === targetLength;
        default: return false;
      }
    }

    // Workflow ID check: workflowId === "value"
    const workflowIdMatch = normalizedCondition.match(/workflowid\s*===\s*['"']([^'"']+)['"']/);
    if (workflowIdMatch) {
      const expectedWorkflowId = workflowIdMatch[1];
      return state.workflowId === expectedWorkflowId;
    }

    // Boolean literal conditions
    if (normalizedCondition === 'true') return true;
    if (normalizedCondition === 'false') return false;

    logger.warn("Unsupported condition format", { 
      condition,
      normalizedCondition,
      supportedPatterns: [
        'intent === "value"',
        'intent.includes("value")',
        'allSlotsFilled === true/false',
        'slotValues.key === "value"',
        'slotValues.key !== undefined',
        'userPrompt.includes("keyword")',
        'userPrompt === "value"',
        'memory.length > number',
        'workflowId === "value"',
        'true/false'
      ]
    });
    
    return false;

  } catch (error) {
    logger.error("Condition evaluation error", { 
      condition, 
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return false;
  }
}

/**
 * Enhanced Router Node Handler
 * 
 * Routes workflow execution based on state conditions using secure evaluation.
 * Returns __routeChosen to enable scheduler edge filtering for single-path execution.
 * 
 * @param state - Current workflow state
 * @param dataClient - Amplify data client for database operations
 * @returns Updated state with routing decision and chosen target
 */
export const handleRouter = async (
  state: State & { ownersForProgress?: string[] },
  dataClient: DataClient
): Promise<RouterResult> => {
  tracer.putAnnotation("Node", "Router");
  tracer.putAnnotation("ConversationId", state.conversationId);
  
  // 1. Compute owners once
  const owners = Array.from(new Set(state.ownersForProgress ?? [state.userId])).filter(Boolean);
  
  logger.info("Router node starting", {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    currentIntent: state.intent,
    allSlotsFilled: state.allSlotsFilled,
    slotCount: Object.keys(state.slotValues || {}).length
  });

  // 2. Emit STARTED right away
  await logProgressForOwners(dataClient, owners, {
    workflowId: state.workflowId,
    conversationId: state.conversationId,
    stepName: "Router",
    status: "STARTED",
    message: "Evaluating routes…",
    metadata: JSON.stringify({ 
      userVisible: true, 
      ui: { 
        kind: "status", 
        title: "Router", 
        body: "Evaluating routes…" 
      } 
    })
  });

  try {
    const config = state.currentNodeConfig as RouterConfig;

    // Handle empty configuration with pass-through behavior
    if (!config || !Array.isArray(config.routes) || config.routes.length === 0) {
      const defaultTarget = state.currentNodeConfig?.defaultRoute || '';
      
      logger.info("No routes configured, using pass-through behavior", {
        defaultTarget
      });
      
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "Router",
        status: "COMPLETED",
        message: defaultTarget || "No routes",
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Route", 
            items: [defaultTarget || "none"] 
          },
          routeCount: 0,
          behavior: "pass_through",
          hasDefaultRoute: !!defaultTarget,
          selectedRoute: defaultTarget
        })
      });

      return {
        nextNode: defaultTarget,
        routingReason: 'default',
        modelResponse: "Routing: No conditions to evaluate, continuing",
        formattedResponse: "Continuing workflow (no routing rules applied)",
        __routeChosen: defaultTarget || undefined
      };
    }

    const {
      routes,
      defaultRoute,
      enableDetailedLogging = false,
      evaluateAllConditions = false
    } = config;

    // Sort routes by priority (lower numbers first)
    const sortedRoutes = [...routes].sort((a, b) => (a.priority || 100) - (b.priority || 100));

    logger.info("Evaluating routing conditions", {
      totalRoutes: routes.length,
      hasDefaultRoute: !!defaultRoute,
      enableDetailedLogging,
      evaluateAllConditions,
      currentStateSnapshot: {
        intent: state.intent,
        allSlotsFilled: state.allSlotsFilled,
        slotKeys: Object.keys(state.slotValues || {}),
        userPromptLength: state.userPrompt?.length || 0,
        memoryLength: state.memory?.length || 0
      }
    });

    const evaluationResults: RouteEvaluationResult[] = [];
    let selectedRoute: RouteCondition | null = null;
    let routingReason = "";

    // 3. Do the work - evaluate routes
    for (const route of sortedRoutes) {
      const matches = evaluateCondition(route.condition, state);
      
      evaluationResults.push({
        condition: route.condition,
        target: route.target,
        matches,
        description: route.description,
        priority: route.priority
      });

      // Select ONLY the first matching route
      if (matches && !selectedRoute) {
        selectedRoute = route;
        routingReason = route.description || route.condition;
        
        logger.info("Router selected first match", {
          node: state.currentNodeId,
          target: selectedRoute.target,
          condition: route.condition,
          description: route.description,
          evaluatedRoutes: evaluationResults.length
        });
        
        if (!evaluateAllConditions) {
          break;
        }
      } else if (enableDetailedLogging) {
        logger.info("Route condition evaluated", {
          condition: route.condition,
          target: route.target,
          matches,
          description: route.description,
          priority: route.priority,
          selected: false
        });
      }
    }

    // Execute ONLY the selected route
    if (selectedRoute) {
      const routeMessage = selectedRoute.target;
      const routeDetails = selectedRoute.description || selectedRoute.condition;
      
      logger.info("Single route selected for execution", {
        condition: selectedRoute.condition,
        target: selectedRoute.target,
        description: selectedRoute.description,
        evaluatedRoutes: evaluationResults.length,
        totalAvailable: routes.length
      });

      // 4. Emit COMPLETED with route choice
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "Router",
        status: "COMPLETED",
        message: routeMessage,
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Route", 
            items: [selectedRoute.target, routeDetails] 
          },
          // Structured metadata for telemetry
          selectedRoute: selectedRoute.target,
          condition: selectedRoute.condition,
          description: selectedRoute.description,
          evaluatedRoutes: evaluationResults.length,
          routingStrategy: evaluateAllConditions ? "evaluate_all_first_match" : "first_match",
          singleRouteExecution: true,
          routerChosenTarget: selectedRoute.target,
          allEvaluationResults: enableDetailedLogging ? evaluationResults : evaluationResults.map(r => ({
            condition: r.condition,
            target: r.target,
            matches: r.matches,
            priority: r.priority
          })),
          stateSnapshot: {
            intent: state.intent,
            allSlotsFilled: state.allSlotsFilled,
            slotCount: Object.keys(state.slotValues || {}).length,
            userPromptLength: state.userPrompt?.length || 0,
            memoryLength: state.memory?.length || 0
          },
          routeConfiguration: {
            totalRoutes: routes.length,
            hasDefaultRoute: !!defaultRoute,
            enableDetailedLogging,
            evaluateAllConditions
          }
        })
      });

      metrics.addMetric("RoutingDecisions", MetricUnit.Count, 1);
      metrics.addMetric("RouteEvaluations", MetricUnit.Count, evaluationResults.length);
      metrics.addMetric("SingleRouteExecutions", MetricUnit.Count, 1);

      return {
        nextNode: selectedRoute.target,
        routingReason,
        modelResponse: `Routing to: ${selectedRoute.target}${selectedRoute.description ? ` (${selectedRoute.description})` : ` (${selectedRoute.condition})`}`,
        formattedResponse: `Routing to: ${selectedRoute.target}${selectedRoute.description ? ` (${selectedRoute.description})` : ` (${selectedRoute.condition})`}`,
        __routeChosen: selectedRoute.target
      };
    }

    // No routes matched - check for default route
    if (defaultRoute) {
      const defaultMessage = defaultRoute;
      
      logger.info("Router fell back to defaultRoute", {
        node: state.currentNodeId,
        target: defaultRoute,
        evaluatedRoutes: evaluationResults.length,
        allResults: enableDetailedLogging ? evaluationResults : undefined
      });

      // 4. Emit COMPLETED with default route
      await logProgressForOwners(dataClient, owners, {
        workflowId: state.workflowId,
        conversationId: state.conversationId,
        stepName: "Router",
        status: "COMPLETED",
        message: defaultMessage,
        metadata: JSON.stringify({
          userVisible: true,
          ui: { 
            kind: "chips", 
            title: "Route", 
            items: [defaultRoute, "(default)"] 
          },
          selectedRoute: defaultRoute,
          reason: "default_route",
          evaluatedRoutes: evaluationResults.length,
          noMatches: true,
          singleRouteExecution: true,
          routerChosenTarget: defaultRoute,
          failedConditions: evaluationResults.map(r => ({
            condition: r.condition,
            target: r.target,
            reason: "condition_evaluated_false"
          })),
          stateSnapshot: {
            intent: state.intent,
            allSlotsFilled: state.allSlotsFilled,
            slotCount: Object.keys(state.slotValues || {}).length,
            userPromptLength: state.userPrompt?.length || 0
          }
        })
      });

      metrics.addMetric("DefaultRoutesUsed", MetricUnit.Count, 1);
      metrics.addMetric("RouteEvaluations", MetricUnit.Count, evaluationResults.length);

      return {
        nextNode: defaultRoute,
        routingReason: "default route (no conditions matched)",
        modelResponse: `No conditions matched, using default route: ${defaultRoute}`,
        formattedResponse: `No conditions matched, using default route: ${defaultRoute}`,
        __routeChosen: defaultRoute
      };
    }

    // No route found and no default - this is an error condition
    const errorMessage = "No matching route found and no default route configured";
    
    logger.warn("Router found no match and no defaultRoute; yielding no next step", {
      node: state.currentNodeId,
      error: errorMessage,
      evaluatedRoutes: evaluationResults.length,
      availableRoutes: routes.map(r => ({
        condition: r.condition,
        target: r.target,
        description: r.description
      })),
      currentState: {
        intent: state.intent,
        allSlotsFilled: state.allSlotsFilled,
        slotKeys: Object.keys(state.slotValues || {}),
        userPromptLength: state.userPrompt?.length || 0
      },
      evaluationResults
    });

    // 5. Emit ERROR on failure
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "Router",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        availableRoutes: routes.map(r => ({
          condition: r.condition,
          target: r.target,
          description: r.description
        })),
        evaluationResults,
        currentState: {
          intent: state.intent,
          allSlotsFilled: state.allSlotsFilled,
          slotKeys: Object.keys(state.slotValues || {}),
          userPromptLength: state.userPrompt?.length || 0
        }
      })
    });

    metrics.addMetric("RoutingErrors", MetricUnit.Count, 1);
    
    return {
      __routeChosen: undefined
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error in Router';
    
    logger.error("Router node failed", {
      error: errorMessage,
      workflowId: state.workflowId,
      conversationId: state.conversationId
    });

    // 5. Emit ERROR on failure (and rethrow)
    await logProgressForOwners(dataClient, owners, {
      workflowId: state.workflowId,
      conversationId: state.conversationId,
      stepName: "Router",
      status: "ERROR",
      message: `Failed: ${errorMessage}`,
      metadata: JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      })
    });

    metrics.addMetric("RouterNodeErrors", MetricUnit.Count, 1);
    
    throw error;
  }
};