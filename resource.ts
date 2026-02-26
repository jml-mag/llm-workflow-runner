// amplify/functions/workflow-runner/resource.ts

import { defineFunction } from "@aws-amplify/backend";

export const workflowRunner = defineFunction({
  entry: "./src/workflowRunnerHandler.ts",
  environment: {
    // ✅ Backward compatibility for older workflows
    BEDROCK_MODEL: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",

    // ✅ New default model for fallbacks
    DEFAULT_MODEL_ID: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    // ✅ Turn on the versioned Prompt Engine (global settings with per-workflow overrides)
    USE_NEW_PROMPT_ENGINE: "true",
  },
  timeoutSeconds: 60,
  resourceGroupName: "data",
});
