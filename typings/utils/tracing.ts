/**
 * Public-repo stub — typings/utils/tracing.ts
 *
 * In the full system this lives in a shared platform package.
 * Here we provide just enough surface for the runner to typecheck.
 */

import type { Tracer } from "@aws-lambda-powertools/tracer";

/** Safely annotate a trace segment, swallowing errors when tracing is unavailable. */
export declare function safePutAnnotation(
  tracer: Tracer,
  key: string,
  value: string | number | boolean
): void;
