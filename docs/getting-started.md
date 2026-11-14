# Getting started

Bounded Swarm Lab is an experimental, private, supervised pilot. Start with Handoff Simulation and synthetic or low-sensitivity text. It is not ready for confidential or unattended daily work.

The repository contains no live Site identity, database, credential, run history, or inherited permission to spend.

## Requirements

- Node.js 22.15 or newer
- npm and the locked dependency set in `package-lock.json`
- OpenAI Sites for the supported hosted identity boundary
- A new D1 database for hosted Live experiments
- For Live only: an owner-controlled OpenAI API project, billing or credits, an enforced project spend limit, and a project-scoped server credential

ChatGPT access and API Platform billing are separate concerns. Confirm current eligibility, billing, model availability, and pricing in the official OpenAI documentation before enabling Live.

## Run the no-charge simulation locally

Install and verify the source:

```text
npm run install:ci
npm run check
```

Keep `.env.local` untracked and start from `.env.example`. Leave the credential blank and Live disabled:

```text
OPENAI_API_KEY=
SWARM_LIVE_ENABLED=false
SWARM_MODEL=gpt-6-luna
SWARM_AUTHORIZED_MICROUSD=0
SWARM_START_THRESHOLD_MICROUSD=0
```

Start the development server with `npm run dev`, sign in through the loopback-only development simulator, and run a Handoff Simulation. Simulation is scripted, makes no provider request, and produces checkpoints rather than task output.

If this checkout will push code, install the reviewed Trivy and Grype versions and activate the tracked hook with `npm run hooks:install`. See [Mandatory vulnerability scanning](security-scanning.md). A missing scanner or a `HIGH`/`CRITICAL` finding blocks the push.

## Create a private hosted deployment

1. Create a new private, owner-only Site. Replace the unconfigured placeholder in `.openai/hosting.json` with the new Site identity through the trusted Sites workflow.
2. Create a fresh D1 database and apply `drizzle/0000_sad_iron_fist.sql`.
3. Deploy with `SWARM_LIVE_ENABLED=false` and no provider credential first.
4. Confirm a signed-out browser cannot access the Site and that only intended users are allowed.
5. Run Handoff Simulation and confirm API Platform usage does not change.
6. Record the first known-good source commit and Site version for rollback.

The hosted application trusts identity headers injected by OpenAI Sites. Do not expose the Worker directly or put it behind an arbitrary proxy. See `SECURITY.md` for the required ingress boundary.

## Explicitly configure a Live pilot

Live has a fail-closed `$0` budget by default. The initial D1 ledger is also seeded at zero. A deployment owner must make a new, explicit decision before any provider call can be reserved.

The included public profile accepts an authorization ceiling up to $10. Values are integer micro-US dollars:

```text
SWARM_AUTHORIZED_MICROUSD=10000000
SWARM_START_THRESHOLD_MICROUSD=9000000
```

The first nonzero configuration can initialize only a pristine zero ledger with no reconciled spend, outstanding reservation, or active step. After initialization, a configuration mismatch fails closed. Raising, lowering, or repairing the persisted ledger requires an explicit audited operator change; it is never inferred from a prior deployment.

Before enabling Live:

1. Create a dedicated OpenAI API project and confirm the allowlisted model and versioned price table are current.
2. Configure an enforced API Platform project spend limit no higher than the application ceiling, with lower alerts.
3. Create a project-scoped service credential and store it only as the server secret `OPENAI_API_KEY`.
4. Set the two budget variables deliberately and redeploy while `SWARM_LIVE_ENABLED=false`.
5. Confirm the health view reports the intended cap, threshold, idle ledger, and closed Live gate.
6. Complete every P0 item in `docs/acceptance.md`.

For a one-step supervised test, use synthetic content, set `SWARM_LIVE_ENABLED=true` only for the test window, authorize one provider step, and then set it back to `false`. Reconcile the application ledger with API Platform usage. Never retry an unknown outcome.

## Before daily use

Complete every P1 item in `docs/acceptance.md` and address `docs/known-limitations.md`. In particular, establish retention and deletion controls, run history, support ownership, recovery procedures, and a controlled quality pilot before entering confidential work information.
