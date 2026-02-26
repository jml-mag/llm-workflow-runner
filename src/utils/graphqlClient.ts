// amplify/functions/workflow-runner/src/utils/graphqlClient.ts
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const GRAPHQL_ENDPOINT = process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT!;
const REGION = process.env.AMPLIFY_DATA_REGION || "us-east-1";

export interface LoadedWorkflow {
  id: string;
  name: string;
  visibility: 'PRIVATE' | 'PUBLIC' | 'AUTHED' | 'SHARED' | 'ADMIN_ONLY';
  owner?: string;  // This comes from allow.owner() authorization
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  description?: string;
  entryPoint: string;
  status: string;
  category?: string;
  tags?: Record<string, unknown>;
  runCount?: number;
  lastUsed?: string;
}

/**
 * Creates a signed GraphQL request for Lambda execution
 * Uses IAM credentials to authenticate with AppSync
 */
async function createSignedRequest(query: string, variables: Record<string, unknown> = {}) {
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: "appsync",
    sha256: Sha256,
  });

  const requestBody = JSON.stringify({ query, variables });
  
  const request = new HttpRequest({
    method: "POST",
    hostname: new URL(GRAPHQL_ENDPOINT).hostname,
    path: new URL(GRAPHQL_ENDPOINT).pathname,
    headers: {
      "Content-Type": "application/json",
      host: new URL(GRAPHQL_ENDPOINT).hostname,
    },
    body: requestBody,
  });

  return await signer.sign(request);
}

/**
 * Executes a GraphQL mutation/query from Lambda
 */
export async function executeGraphQL(query: string, variables: Record<string, unknown> = {}) {
  try {
    const signedRequest = await createSignedRequest(query, variables);
    
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(signedRequest.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value[0] : value,
        ])
      ),
      body: signedRequest.body,
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await response.json()) as Record<string, any>;

    if (result.errors) {
      console.error("GraphQL errors:", result.errors);
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  } catch (error) {
    console.error("GraphQL execution failed:", error);
    throw error;
  }
}

export async function loadWorkflowById(workflowId: string): Promise<LoadedWorkflow> {
  const query = `
    query GetWorkflow($id: ID!) {
      getWorkflow(id: $id) {
        id
        name
        visibility
        owner
        nodes
        edges
        description
        entryPoint
        status
        category
        tags
        runCount
        lastUsed
      }
    }
  `;

  const data = await executeGraphQL(query, { id: workflowId });
  
  if (!data?.getWorkflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const workflow = data.getWorkflow;
  
  // Parse JSON strings to objects for nodes and edges
  return {
    ...workflow,
    nodes: typeof workflow.nodes === 'string' ? JSON.parse(workflow.nodes) : workflow.nodes,
    edges: typeof workflow.edges === 'string' ? JSON.parse(workflow.edges) : workflow.edges,
    tags: typeof workflow.tags === 'string' ? JSON.parse(workflow.tags) : workflow.tags,
  } as LoadedWorkflow;
}