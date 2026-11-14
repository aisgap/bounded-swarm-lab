# Release acceptance criteria

## P0 — required before private deployment

- [ ] The protected `main` branch requires the CI, Trivy, and Grype status checks, requires pull requests, and has no direct-push or administrator bypass.
- [ ] A clean checkout has activated the tracked pre-push hook with `npm run hooks:install`; both scanners pass with fresh vulnerability data.
- [ ] Handoff Simulation success, rework, loop, invalid route, simulated provider ambiguity, every configured limit, timeout, and user stop are deterministic.
- [ ] Browser inputs cannot expand server bounds or select an unpriced model.
- [ ] A create/step/stop idempotency key can cause each logical mutation at most once.
- [ ] Only one global provider dispatch can be active; duplicate or concurrent requests return durable existing state.
- [ ] Cost is stored as integer micro-USD. A fresh public deployment begins at a $0 authorization and $0 start threshold; no provider call can be reserved in that state.
- [ ] A nonzero budget requires explicit `SWARM_AUTHORIZED_MICROUSD` and `SWARM_START_THRESHOLD_MICROUSD` values, remains at or below the included $10 maximum, and can initialize only a pristine zero ledger.
- [ ] After initialization, a runtime/ledger configuration mismatch fails closed. Projected reconciled plus outstanding cost must remain below the configured start threshold and at or below the configured authorization.
- [ ] Every provider dispatch is reserved durably before `fetch`; known usage reconciles; timeout/network ambiguity keeps the reservation.
- [ ] Provider calls have a finite deadline, make no automatic retries, disable tools and storage, and use strict structured output.
- [ ] Refusal, incomplete output, invalid schema, invalid route, missing usage, auth, billing, rate limit, overload, and unknown outcomes are terminal and safe.
- [ ] Every run and record query is scoped by the stable authenticated Site user ID.
- [ ] Hosted identity comes only from trusted Sites ingress. Any alternative ingress strips client-supplied `oai-authenticated-user-*` headers and prevents direct Worker bypass.
- [ ] Cross-site writes, oversized JSON, and malformed payloads fail before mutation.
- [ ] Logs and exported operational receipts contain no objectives, criteria, prompts, records, email addresses, filenames, credentials, or provider bodies.
- [ ] UI works in Handoff Simulation mode, does not use local storage, prevents accidental double starts, clearly states that scripted checkpoints are not task output, and keeps live mode locked by default.
- [ ] Tests, strict type checking, production build, local D1 migration, and secret scan pass.
- [ ] Site remains private. Prior deployed version is documented and can be redeployed without reversing the migration.

## P1 — required before any operator uses it for daily work

- [ ] Representative work tasks, confidentiality requirements, supporting-file needs, and required output format are documented and evaluated.
- [ ] Product-level retention and deletion policy is agreed and implemented.
- [ ] Ongoing operating budget and alert thresholds are separately approved; no pilot authorization is reused as a daily operating budget.
- [ ] Project key rotation owner and cadence are assigned.
- [ ] Backup, incident response, support contact, and recovery drill are completed.
- [ ] Accessibility and supported-browser checks pass on desktop and mobile.
- [ ] A controlled pilot demonstrates acceptable output quality with human review; no UI implies that simulated or model output is independently verified.
