# Sandbox Worker-API Implementation Summary

## Scope

This implementation focused on the `apps/sandbox` worker-api and the sandbox spawn lifecycle:

- spawn sandbox container from a workflow
- default container image set to Node
- resolve user credentials from Secrets Store and pass into container env
- persist session lifecycle metadata in D1
- keep container-side Durable Object alive via periodic healthchecks

## Runtime Architecture

### 1. HTTP API (Hono)

Entrypoint: `apps/sandbox/src/index.ts`

- `GET /`
  - basic service health response
- `POST /sessions`
  - validates input payload
  - creates workflow instance to orchestrate spawn
  - writes scheduled session metadata to D1
- `GET /sessions/:sessionId`
  - reads session metadata/status from D1

### 2. Workflow Orchestration

Implementation: `apps/sandbox/src/workflow.ts` (`SandboxSpawnWorkflow`)

Responsibilities:

- ensure D1 schema exists
- store initial session metadata (`scheduled`)
- resolve credentials from Secrets Store bindings
- call sidecar RPC `/start` to boot container
- update D1 status to `running`
- perform periodic sidecar healthchecks (`/health`)
- persist health status in D1 as `waiting`
- mark session `errored` if healthcheck fails or sidecar stops running

### 3. Container Sidecar Durable Object

Implementation: `apps/sandbox/src/sidecar.ts` (`SandboxContainerSidecar`)

Responsibilities:

- receive `/start` and `/health` RPC calls
- start container via `this.ctx.container.start(...)`
- inject runtime env (credentials, prompt, session metadata)
- set inactivity timeout to reduce premature teardown risk
- attach `container.monitor()` lifecycle listener
- store minimal timestamps in DO storage (`startedAt`, `stoppedAt`)

## Data Layer (D1 + workers-qb)

Implementation: `apps/sandbox/src/db.ts`

Uses `workers-qb` (`D1QB`) for D1 operations:

- schema creation (`createTable`)
- upsert session row (`raw` with conflict update)
- status updates (`update`)
- session retrieval (`fetchOne`)

Session model is defined in `apps/sandbox/src/types.ts` and includes:

- workflow instance id
- sidecar identity
- prompt/repository metadata
- container image
- health state + timestamps
- error message
- created/updated timestamps

## Error Handling Strategy

`neverthrow` is used across HTTP, workflow, sidecar RPC, and storage operations.

- `ResultAsync` for async boundaries
- structured `AppError` (`status`, `code`, `message`)
- consistent mapping from unknown exceptions to typed application errors

Supporting modules:

- `apps/sandbox/src/errors.ts`
- `apps/sandbox/src/result.ts`
- `apps/sandbox/src/secrets.ts`
- `apps/sandbox/src/sidecar-rpc.ts`

## Configuration/BINDINGS

Worker configuration in `apps/sandbox/wrangler.jsonc` includes:

- D1 binding (`SESSIONS_DB`)
- Durable Object binding (`SANDBOX_SIDECAR`)
- Workflow binding (`SANDBOX_SPAWN_WORKFLOW`)
- Secrets Store bindings (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`)
- Container config for sidecar class with Node image
- default `SANDBOX_IMAGE` var

## Refactor Outcome

The original large `index.ts` was decomposed to improve readability and maintainability:

- workflow logic extracted to `workflow.ts`
- sidecar container control extracted to `sidecar.ts`
- D1 logic centralized in `db.ts`
- secret + RPC + error/result helpers extracted to dedicated modules
- `index.ts` now focuses on HTTP routing and exports

## Validation

TypeScript validation was run after refactor:

- `cd apps/sandbox && bunx tsc --noEmit` passed
