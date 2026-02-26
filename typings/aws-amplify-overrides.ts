/**
 * Public-repo stub — typings/aws-amplify-overrides.ts
 *
 * Ambient module declarations that override the real aws-amplify types.
 * The full Amplify Gen 2 type system relies on codegen output that lives
 * outside this repository; replicating it is impractical.  These
 * declarations give `generateClient<Schema>()` a permissive return type
 * so the codebase typechecks without the codegen.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "aws-amplify/data" {
  /** Permissive stub for the Amplify data client. */
  interface DataClientStub {
    models: any;
    [key: string]: any;
  }

  export function generateClient<T = any>(): DataClientStub;
}

declare module "aws-amplify" {
  export const Amplify: {
    configure(resourceConfig: any, libraryOptions?: any): void;
  };
}

declare module "@aws-amplify/backend/function/runtime" {
  export function getAmplifyDataClientConfig(env: any): Promise<{
    resourceConfig: any;
    libraryOptions: any;
  }>;
}
