# llm-workflow-runner

A production-grade, graph-based execution engine for stateful LLM workflows.

This repository contains the **workflow execution core** extracted from a larger AI platform. It is designed to run asynchronous, multi-step LLM workflows inside AWS Lambda, with real-time progress streaming, conditional routing, multi-turn state, and cost-aware model orchestration.

This is **not a demo chatbot** and not a turnkey SDK. It is a reference implementation of how to build *operable* AI features once you move past single-prompt experiments.

---

## Why This Exists

Most LLM examples stop at:

```ts
prompt → model → response
```

That works for demos. It breaks down immediately in real products.

Real AI features are:

* **Stateful** — conversations span multiple turns
* **Asynchronous** — model calls take seconds, not milliseconds
* **Expensive** — every token has a real cost
* **Conditional** — different inputs require different paths
* **Observable** — users and operators need progress and failure visibility
* **Multi-tenant** — data access and visibility must be enforced

This workflow runner exists to make LLM execution **predictable, resumable, observable, and controllable**.

---

## What This Repository Is (and Isn’t)

### This *is*:

* The execution engine for graph-based LLM workflows
* A real, production-tested architecture
* Designed for AWS Lambda + DynamoDB + Bedrock
* A reference for senior engineers and architects

### This is *not*:

* A complete application
* A local-first runnable demo
* An SDK with mocks for every cloud dependency
* A UI or workflow builder

Some modules are intentionally stubbed to keep this extract focused and safe to publish.

---

## Core Concepts

### 1. Workflows Are Graphs, Not Functions

Workflows are defined as **validated JSON graphs** and executed as LangGraph state machines.

* Nodes represent discrete steps (memory, classification, generation, search, formatting)
* Edges represent execution flow
* Some edges are conditional and evaluated at runtime

Only one path executes per invocation.

---

### 2. Execution Is Asynchronous by Design

The HTTP layer **never calls models directly**.

Instead:

1. An API handler validates access
2. It fires an async Lambda invocation
3. It returns immediately (`202 Accepted`)
4. Clients subscribe to progress events

This avoids hung requests, cold-start penalties, and brittle long-polling.

---

### 3. Shared State Drives Everything

All nodes read from and write to a shared execution state:

* Identity & session info
* Conversation memory
* Slot values (for multi-turn collection)
* Routing decisions
* Retrieved context (RAG)
* Model outputs

Nodes return **partial state updates**, which are merged via LangGraph reducers.

---

### 4. Progress Is a First-Class Output

Every node emits progress events:

* `STARTED`
* `STREAMING` (per token chunk)
* `AWAITING_INPUT`
* `COMPLETED`
* `ERROR`

Progress is dual-written for every “owner” who should see it, enabling:

* shared visibility
* public workflows
* admin dashboards
* real-time UX without WebSockets

---

## Execution Flow (High Level)

```
HTTP Request
  ↓
API Handler (auth + access check)
  ↓
Async Lambda invoke (workflow-runner)
  ↓
Graph assembly (LangGraph)
  ↓
Node execution (one path only)
  ↓
Progress streamed to DynamoDB
  ↓
Client UI updates in real time
```

Multi-turn workflows may halt at `AWAITING_INPUT` and resume later with hydrated state.

---

## Node Types

This runner supports a set of composable node types, each with a single responsibility:

| Node               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| ConversationMemory | Load and persist conversation history            |
| IntentClassifier   | Classify user intent via LLM                     |
| Router             | Conditionally choose the next node (no `eval`)   |
| SlotTracker        | Collect structured inputs across turns           |
| VectorSearch       | Retrieve context from a vector store (RAG)       |
| VectorWrite        | Persist embeddings                               |
| ModelInvoke        | Call an LLM (streaming or non-streaming)         |
| Format             | Apply output formatting (text / markdown / JSON) |
| StreamToClient     | Finalize execution and emit completion           |

Backward-compatible aliases are maintained for workflow evolution.

---

## LLM Orchestration

### Model Registry

Models are defined centrally with:

* Provider (Bedrock / OpenAI / etc.)
* Context window
* Streaming & JSON capabilities
* Token estimation strategy
* Pricing metadata (vendor-published rates)

This allows workflows to switch models **without changing execution logic**.

### Cost Awareness

Before any model call:

* Token budgets are estimated
* Costs are projected
* Requests that would exceed configured caps are blocked

Vendor pricing is included for realism; business-specific spending limits are configurable.

---

## Multi-Turn Slot Collection

The `SlotTracker` node enables conversational data collection without bespoke state machines.

* Slots have validation rules and retry limits
* Progress is persisted to conversation metadata
* Execution halts cleanly while waiting for input
* Resumes on the next invocation with full context

This works even if the user closes their browser and returns later.

---

## Access Control & Multi-Tenancy

Access rules are enforced at execution time:

* `PRIVATE`, `AUTHED`, `PUBLIC`, `SHARED`, `ADMIN_ONLY`
* Collection-scoped document filtering for RAG
* Namespace isolation for vector search
* Multi-owner progress visibility

These patterns are intentionally left intact — they demonstrate real-world system concerns.

---

## Repository Structure (Guided Tour)

If you’re reading the code, start here:

* **`src/workflowRunnerHandler.ts`**
  Entry point. Validates context, hydrates state, invokes the graph.

* **`src/runner.ts`**
  Builds and executes the LangGraph state machine.

* **`src/nodeRegistry.ts`**
  Maps workflow node types to handlers.

* **`src/nodes/`**
  All node implementations.

* **`src/utils/progress.ts`**
  Progress event emission and dual-write logic.

* **`src/prompt-engine/`**
  Prompt construction, token budgeting, truncation, and safety checks.

* **`src/modelCapabilities.ts`**
  Canonical model registry and metadata.

* **`src/config/env.ts`** / **`env.example`**
  Centralized environment contract.

* **`src/adapters/dataClient.ts`**
  Isolates AWS Amplify / AppSync coupling.

* **`typings/`**
  Public-repo stubs for modules defined elsewhere in the full system.

---

## TypeScript Posture

This repo is intended to **typecheck cleanly**, not to fully compile or deploy.

* `npm run typecheck` validates correctness
* Some modules are stubbed as `any` to avoid leaking internal schemas
* A relaxed check config is used to avoid noise from deep cloud SDK generics

This reflects a deliberate tradeoff: clarity over completeness.

---

## Integration Assumptions

Running this in a real environment requires:

* AWS Lambda
* DynamoDB (multiple tables)
* AWS Bedrock (for model inference)
* A vector database (e.g. Pinecone)
* S3 + KMS (optional prompt archiving)
* AWS Amplify / AppSync (data access layer)

This repository documents *how the engine works*, not how to provision all infrastructure.

---

## Non-Goals

* Being a generic workflow SDK
* Providing local mocks for every AWS service
* Optimizing for minimal code size
* Hiding complexity that real systems require

---

## License

MIT