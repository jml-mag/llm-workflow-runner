// src/adapters/dataClient.ts
//
// Thin adapter that isolates the Amplify Data client initialisation.
// The rest of the codebase imports `DataClient` from here instead of
// reaching for aws-amplify/data + Schema directly.
//
// In an open-source / local-dev context you could swap the body of
// `createDataClient()` with a stub that satisfies the same interface.

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/workflowRunnerHandler";
import type { Schema } from "@platform/data/resource";

// ── Exported type ──────────────────────────────────────────────
/** The Amplify-generated data client used throughout the runner. */
export type DataClient = ReturnType<typeof generateClient<Schema>>;

// ── Factory ────────────────────────────────────────────────────
/**
 * Initialise Amplify and return a typed data client.
 *
 * Call this once in the Lambda handler entry-point; pass the
 * resulting client down to all subsystems that need data access.
 */
export async function createDataClient(): Promise<DataClient> {
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  return generateClient<Schema>();
}
