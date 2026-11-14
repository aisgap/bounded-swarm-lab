# Architecture

Bounded Swarm Lab separates deterministic orchestration from provider-connected execution. The system is designed to stop safely rather than guess, retry, or continue after an ambiguous outcome.

## Major components

| Area | Responsibility |
| --- | --- |
| `app/` | Authenticated browser UI and JSON routes |
| `lib/swarm/` | Pure workflow transitions, fixed bounds, pricing, validation, and safe receipt logic |
| `lib/server/` | Trusted runtime configuration, D1 persistence, prompt construction, and the provider adapter |
| `db/`, `drizzle/` | Schema and additive D1 migration |
| `worker/` | Cloudflare Worker entry point |
| `test/` | Deterministic success, limit, concurrency, and failure-path tests |

## Execution modes

### Handoff Simulation

Simulation runs entirely through deterministic local state. It uses the same four role names and stopping concepts as Live but makes no provider request, requires no credential, and does not persist task data in browser local storage. Its entries are scripted checkpoints, not AI-generated work product.

### Live experiment

A Live run is created in D1 before any provider work. Each user action can reserve and dispatch at most one provider request:

1. Authenticate the Site user and validate origin, JSON shape, and input size.
2. Load the user-scoped run and prior records.
3. Check the run deadline, call/handoff/visit/token limits, configured price table, run cost limit, global ledger, and single-dispatch lease.
4. Durably reserve worst-case token cost and a unique step before network dispatch.
5. Send one bounded Responses API request with tools and provider-side storage disabled.
6. Validate the structured result and usage accounting.
7. Reconcile actual cost, append one durable record, and commit the next legal state.

There are no automatic provider retries. A timeout or broken connection after dispatch is an unknown outcome: the full reservation remains outstanding and the run stops.

## Trust boundaries

### Identity

The supported hosted deployment relies on OpenAI Sites to authenticate users and inject `oai-authenticated-user-*` headers. The stable authenticated user ID owns runs and records; email is not used as the ownership key.

The Worker must not be reachable through an ingress path where a client can supply those headers. Direct Worker and arbitrary reverse-proxy deployments are unsupported unless they strip client identity headers and replace them only after trusted authentication.

### Provider credential

`OPENAI_API_KEY` is a server-only secret. It must not appear in source, browser bundles, logs, database rows, build archives, screenshots, or issue attachments. The browser receives only a boolean provider-readiness signal.

### Cost authorization

The public configuration starts at zero. `SWARM_AUTHORIZED_MICROUSD` and `SWARM_START_THRESHOLD_MICROUSD` are explicit server configuration, and the D1 ledger is the durable atomic reservation authority. A pristine ledger can be initialized once from a valid nonzero configuration; later mismatches fail closed.

The API Platform project spend limit is a separate backstop. Application accounting and provider usage must be reconciled after a Live window.

## Data handling

Live objectives, acceptance criteria, steps, and role records persist in D1 and are scoped by authenticated user ID. The browser does not use local storage for task content. Operational logs and exported receipts are limited to allowlisted identifiers, state names, counters, timings, safe error codes, and integer micro-dollar amounts; they exclude prompts, objectives, criteria, records, filenames, email addresses, credentials, and provider bodies.

The current product has no user-facing deletion, retention, or run-history interface. That is a release blocker for confidential daily use, documented in `docs/known-limitations.md`.

## Recovery model

- Application changes roll back by redeploying a recorded known-good version.
- D1 migrations are additive and are not reversed during an incident.
- Unknown provider outcomes remain reserved until an explicit audited reconciliation.
- Credential uncertainty triggers Live disablement and key revocation or rotation.
- Budget or price-table uncertainty triggers Live disablement until source, ledger, and provider usage agree.
