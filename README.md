# Bounded Swarm Lab

[![CI](https://github.com/aisgap/bounded-swarm-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/aisgap/bounded-swarm-lab/actions/workflows/ci.yml)
[![Vulnerability Scans](https://github.com/aisgap/bounded-swarm-lab/actions/workflows/vulnerability-scans.yml/badge.svg)](https://github.com/aisgap/bounded-swarm-lab/actions/workflows/vulnerability-scans.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Bounded Swarm Lab is an experimental four-role workbench for studying a deliberately limited multi-agent workflow. It provides a deterministic, no-charge Handoff Simulation and a manually gated OpenAI API path for supervised experiments.

> **Experimental private pilot:** this project is not ready for confidential, unattended, or production daily work. Start with synthetic or low-sensitivity text and read [Known limitations](docs/known-limitations.md).

This community project uses OpenAI APIs and OpenAI Sites integration points. It is not an official OpenAI product and is not endorsed or supported by OpenAI.

## What it demonstrates

The workflow passes a bounded record through four roles:

1. `researcher`
2. `architect`
3. `coder`
4. `reviewer`

The browser cannot expand the server-side limits, advance Live work automatically, or trigger an automatic provider retry.

| Control | Included profile |
| --- | ---: |
| Provider calls per run | 6 |
| Handoffs per run | 5 |
| Visits per role | 2 |
| Total reserved tokens | 24,000 |
| Input reservation per call | 3,000 tokens |
| Output reservation per call | 1,000 tokens |
| Concurrent provider calls | 1 globally |
| Automatic retries | 0 |
| Whole-run deadline | 60 seconds |
| Default Live authorization | $0 |
| Maximum configurable pilot ceiling | $10 |

A timeout or broken connection after dispatch becomes an unknown outcome. The full reservation remains outstanding and the run stops without retrying.

## Modes

- **Handoff Simulation** is the default. It makes no provider call, needs no credential, and produces deterministic scripted checkpoints rather than AI task output.
- **Live experiment** is fail-closed by default. It requires a private supported deployment, a healthy D1 ledger, a server-only project credential, explicit budget variables, an external API Platform spend backstop, and `SWARM_LIVE_ENABLED=true`. Each provider step still requires a separate user action.

The repository contains no active Site identity, database, credential, run history, or inherited permission to spend.

## Simulation-only quick start

Requirements: Node.js 22.18 or newer and npm.

```text
npm run install:ci
npm run check
npm run dev
```

Start from `.env.example`, keep `OPENAI_API_KEY` blank, and leave all Live controls at zero or false. The local development sign-in simulator is loopback-only.

See [Getting started](docs/getting-started.md) for private deployment, D1 migration, identity-boundary, and supervised Live-pilot instructions.

## Explicit Live authorization

The initial migration and default environment configure a `$0` ledger. Merely adding an API key or opening the Live gate cannot authorize spend.

The included public pilot profile accepts at most $10, expressed as integer micro-US dollars:

```text
SWARM_AUTHORIZED_MICROUSD=10000000
SWARM_START_THRESHOLD_MICROUSD=9000000
```

The first nonzero configuration can initialize only a pristine ledger with no spend, outstanding reservation, or active dispatch. Later configuration mismatches fail closed and require an explicit audited operator repair.

Before enabling Live, the deployment owner must also set an enforced API Platform project spend limit, verify model access and current pricing, store a project-scoped credential only as a server secret, complete every P0 acceptance item, and run a private no-charge smoke test. The versioned standard price table was last checked against [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) on November 14, 2026.

## Supported deployment boundary

The supported hosted configuration relies on OpenAI Sites to authenticate visitors and inject trusted `oai-authenticated-user-*` headers. Direct Worker or arbitrary reverse-proxy deployment is unsupported unless the public edge strips all client-supplied identity headers and only a trusted authentication layer can add replacements. See [Security policy](SECURITY.md).

## Data handling

- Handoff Simulation keeps its scripted state in the browser session and does not call the provider.
- Live objectives, acceptance criteria, steps, and role records persist in the deployment owner's D1 database.
- Operational logs use allowlisted identifiers, states, counters, timings, and integer micro-dollar amounts; they exclude task and provider bodies.
- The current product has no user-facing deletion, retention, or run-history controls.

## Quality gates

`npm run check` performs the source secret scan, linting, deterministic tests, strict type checking, production build, and artifact secret scan. Every code push must also pass independent Trivy and Grype vulnerability gates locally and in GitHub. Both scanners include development dependencies and fail on `HIGH` or `CRITICAL` findings, scanner errors, stale data, or timeouts. CI runs the provider-free checks with Live disabled, no API credential, read-only repository permissions, bounded runtime, and dependency lifecycle scripts disabled.

The tests cover bounds, legal transitions, idempotency, ownership isolation, cost reservation and reconciliation, concurrency, finite provider deadlines, refusal and malformed-output handling, ambiguous outcomes, origin checks, log redaction, UI gating, and provider-free simulation.

## Repository map

- `app/` — protected UI and JSON routes
- `lib/swarm/` — pure workflow, limits, pricing, validation, and safe logging logic
- `lib/server/` — authentication-aware persistence, prompting, and provider adapter
- `db/`, `drizzle/` — D1 schema and additive migration
- `test/` — deterministic unit and failure-path tests
- `docs/` — architecture, setup, acceptance, operations, and known limitations
- `.openai/hosting.json` — deliberately unconfigured Site placeholder

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Mandatory vulnerability scanning](docs/security-scanning.md)
- [Release acceptance criteria](docs/acceptance.md)
- [Operations runbook](docs/runbook.md)

## License

Copyright © 2026 AISGAP. Released under the [MIT License](LICENSE).
