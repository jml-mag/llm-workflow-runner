// amplify/functions/workflow-runner/src/utils/PromptBuilder.ts

import { Logger } from '@aws-lambda-powertools/logger';
import { getModelById } from '../../src/modelCapabilities';
import type { State } from '../types';

const logger = new Logger({ serviceName: 'PromptBuilder' });

// Interfaces for structured prompt building
export interface PromptBuildOptions {
    stepPrompt: string;
    input: string;
    context?: Record<string, unknown>;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    modelId: string;
    useBasePrompt?: boolean;
}

export interface PromptBuildResult {
    finalPrompt: string;
    metadata: {
        promptVersionUsed: string;
        outputSchemaVersion: string;
        modelId: string;
        supportsJSONMode: boolean;
        supportsStreaming: boolean;
        basePromptIncluded: boolean;
        segmentBreakdown: {
            basePrompt: number;
            stepPrompt: number;
            context: number;
            history: number;
            userInput: number;
        };
        totalTokensEstimate: number;
        assemblyTimestamp: string;
    };
}

/**
 * Centralized Prompt Builder optimized for Amplify Gen 2
 */
class PromptBuilder {
    private static instance: PromptBuilder;
    private baseSystemPrompt: string | null = null;
    private basePromptVersion: string | null = null;
    private lastLoadTime: number = 0;
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    private constructor() { }

    static getInstance(): PromptBuilder {
        if (!PromptBuilder.instance) {
            PromptBuilder.instance = new PromptBuilder();
        }
        return PromptBuilder.instance;
    }

    /**
     * Load base system prompt - Embedded version with file fallback
     */
    private async loadBasePrompt(): Promise<{ prompt: string; version: string }> {
        const now = Date.now();

        // Return cached version if still valid
        if (this.baseSystemPrompt && this.basePromptVersion &&
            (now - this.lastLoadTime) < this.CACHE_TTL) {
            return {
                prompt: this.baseSystemPrompt,
                version: this.basePromptVersion
            };
        }

        // Try to load from file first (optional)
        let content = '';
        let loadedFrom = '';

        // Use embedded version if file not found (primary source now)
        if (!content) {
            loadedFrom = 'embedded';
            logger.info('Using embedded base system prompt', {
                reason: 'Asset file not found in any location',
                searchedPaths: ['assets', 'fallbacks'],
                deploymentContext: {
                    nodeEnv: process.env.NODE_ENV,
                    lambdaTaskRoot: process.env.LAMBDA_TASK_ROOT,
                    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME
                }
            });

            content = `// version: 2025.08.16-1
// Base System Prompt for Workflow Runner LLM Interactions
// This prompt establishes the foundation for all model interactions across the platform

You are an AI assistant operating within a production workflow automation and document processing system. Your role is to provide intelligent, helpful, and accurate responses while maintaining consistency with the platform's capabilities and user expectations.

## Core Principles

**Accuracy & Reliability**: Provide factual, well-reasoned responses. When uncertain, acknowledge limitations clearly.

**Platform Integration**: You operate within a structured workflow system with defined capabilities including document processing, vector search, conversation memory, and multi-step orchestration.

**User Focus**: Prioritize user needs and provide actionable, relevant assistance. Adapt your communication style to the user's level of expertise.

**Structured Output**: When working within workflows, follow the specified output format precisely to ensure proper system integration.

## Response Guidelines

- Be concise yet comprehensive
- Use clear, professional language
- Provide step-by-step guidance when appropriate  
- Reference relevant platform capabilities when beneficial
- Maintain context awareness across conversation turns
- Handle errors gracefully with helpful alternatives

## Output Format Compliance

Your responses will be processed by downstream workflow components. Follow these formatting requirements:
- Maintain consistent JSON structure when specified
- Use proper markdown formatting for readable text
- Include relevant metadata in structured sections
- Ensure all responses are parseable by the platform's processing engines

## Context Awareness

You have access to:
- Previous conversation history (when memory is enabled)
- User profile information and preferences
- Document context from vector searches
- Workflow state and progression data

Use this context intelligently to provide personalized, relevant responses that advance the user's goals within the platform ecosystem.

Remember: You are a critical component in a larger automated system. Your responses directly influence workflow execution and user experience. Maintain high standards of accuracy, helpfulness, and integration compatibility.`;
        }

        try {
            // Extract version from comment header
            const versionMatch = content.match(/\/\/ version: (.+)/);
            const version = versionMatch ? versionMatch[1] : '2025.08.07-1';

            // Remove comment headers for clean prompt
            const cleanPrompt = content.replace(/^\/\/.*$/gm, '').trim();

            this.baseSystemPrompt = cleanPrompt;
            this.basePromptVersion = version;
            this.lastLoadTime = now;

            logger.info('Base system prompt cached successfully', {
                version,
                length: cleanPrompt.length,
                source: loadedFrom,
                cacheUpdated: true
            });

            return { prompt: cleanPrompt, version };

        } catch (error) {
            logger.error('Failed to process base system prompt', {
                error: error instanceof Error ? error.message : 'Unknown error',
                contentLength: content.length,
                loadedFrom
            });

            // Emergency fallback
            const emergencyPrompt = 'You are a helpful AI assistant operating within an automated workflow system.';
            return { prompt: emergencyPrompt, version: 'emergency-fallback-v1' };
        }
    }

    /**
     * Build complete prompt with base system prompt injection
     * Returns messages array compatible with LangChain
     */
    async buildPrompt(options: PromptBuildOptions): Promise<{
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        metadata: PromptBuildResult['metadata'];
    }> {
        const startTime = Date.now();

        // Ensure modelId provided
        if (!options.modelId) {
            throw new Error('PromptBuilder.buildPrompt requires options.modelId to be set');
        }

        logger.info('Building prompt', {
            modelId: options.modelId,
            stepPromptLength: options.stepPrompt.length,
            inputLength: options.input.length,
            hasContext: !!options.context,
            historyLength: options.history?.length || 0,
            useBasePrompt: options.useBasePrompt !== false
        });

        // Get model capabilities
        const model = getModelById(options.modelId);
        if (!model) {
            throw new Error(`Model not found in registry: ${options.modelId}`);
        }

        // Load base prompt if enabled
        const basePromptData = options.useBasePrompt !== false ?
            await this.loadBasePrompt() :
            { prompt: '', version: 'disabled' };

        // Variable interpolation context
        const interpolationContext = {
            input: options.input,
            context: options.context || {},
            history: options.history || [],
            model: {
                id: model.id,
                provider: model.provider,
                displayName: model.displayName
            },
            timestamp: new Date().toISOString()
        };

        // Apply variable interpolation to step prompt
        const interpolatedStepPrompt = this.interpolateVariables(
            options.stepPrompt,
            interpolationContext
        );

        // Build messages array for LangChain compatibility
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

        // System message with base prompt and step prompt combined
        let systemContent = '';
        if (basePromptData.prompt) {
            systemContent += basePromptData.prompt;
        }
        if (interpolatedStepPrompt.trim()) {
            systemContent += systemContent ? '\n\n' + interpolatedStepPrompt : interpolatedStepPrompt;
        }

        if (systemContent) {
            messages.push({ role: 'system', content: systemContent });
        }

        // Add conversation history
        if (options.history) {
            messages.push(...options.history);
        }

        // User input message
        if (options.input.trim()) {
            messages.push({ role: 'user', content: options.input });
        }

        // Calculate segment breakdown for metadata
        const segmentBreakdown = {
            basePrompt: basePromptData.prompt.length,
            stepPrompt: interpolatedStepPrompt.length,
            context: JSON.stringify(options.context || {}).length,
            history: (options.history || []).reduce((sum, h) => sum + h.content.length, 0),
            userInput: options.input.length
        };

        // Estimate tokens (rough calculation: ~4 chars per token)
        const totalContent = messages.map(m => m.content).join(' ');
        const totalTokensEstimate = Math.ceil(totalContent.length / 4);

        const metadata = {
            promptVersionUsed: basePromptData.version,
            outputSchemaVersion: 'v1',
            modelId: options.modelId,
            supportsJSONMode: model.apiConventions?.supportsJSONMode || false,
            supportsStreaming: model.apiConventions?.supportsStreaming || false,
            basePromptIncluded: options.useBasePrompt !== false,
            segmentBreakdown,
            totalTokensEstimate,
            assemblyTimestamp: new Date().toISOString()
        };

        const buildTime = Date.now() - startTime;

        logger.info('Prompt build completed', {
            messageCount: messages.length,
            estimatedTokens: totalTokensEstimate,
            buildTimeMs: buildTime,
            promptVersion: basePromptData.version,
            modelSupportsJSON: metadata.supportsJSONMode,
            modelSupportsStreaming: metadata.supportsStreaming
        });

        return {
            messages,
            metadata
        };
    }

    /**
     * Simple variable interpolation
     */
    private interpolateVariables(
        template: string,
        context: Record<string, unknown>
    ): string {
        return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
            const value = this.getNestedValue(context, path.trim());
            return value !== undefined ? String(value) : match;
        });
    }

    /**
     * Get nested object value by dot notation path
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
     * Static method for easy access
     */
    static async buildPrompt(options: PromptBuildOptions): Promise<{
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        metadata: PromptBuildResult['metadata'];
    }> {
        const instance = PromptBuilder.getInstance();
        return instance.buildPrompt(options);
    }
}

/**
 * Utility function to create prompt build options from workflow state
 */
export function createPromptOptionsFromState(
    state: State,
    stepPrompt?: string
): PromptBuildOptions {
    const config = state.currentNodeConfig || {};

    return {
        stepPrompt: stepPrompt || config.systemPrompt || '',
        input: state.userPrompt || '',
        context: {
            workflowId: state.workflowId,
            conversationId: state.conversationId,
            userId: state.userId,
            nodeId: state.currentNodeId,
            nodeType: state.currentNodeType,
            slots: state.slotValues || {},
            intent: state.intent || ''
        },
        history: state.memory || [],
        modelId: config.modelId || process.env.DEFAULT_MODEL_ID || 'unknown',
        useBasePrompt: true
    };
}

// Export default
export default PromptBuilder;