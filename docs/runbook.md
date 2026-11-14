# Operations runbook

## Normal experiment window

1. Confirm the Site is private and the deployed commit passed `npm run check`.
2. Confirm trusted Sites ingress is the only public path to the Worker.
3. Confirm D1 shows no active or unknown dispatch and that its authorization and threshold match the explicitly configured `SWARM_AUTHORIZED_MICROUSD` and `SWARM_START_THRESHOLD_MICROUSD` values.
4. Confirm the OpenAI project enforced spend limit is no higher than the application authorization, lower alerts are active, and the project key is current.
5. Enable live execution on the server for the planned window.
6. Execute one bounded step at a time. Never refresh or repeat a step whose outcome is unknown.
7. Disable live execution when the window ends.
8. Reconcile D1 usage and outstanding reservations against the OpenAI project usage view.

## First budget initialization

1. Leave `SWARM_LIVE_ENABLED=false`.
2. Confirm the deployment owner has made a new pilot-spend decision; public source carries no inherited authorization.
3. Confirm the D1 ledger is pristine: zero authorization, threshold, reconciled spend, and outstanding spend, with no active step.
4. Set both budget variables as non-negative integer micro-US dollars. The included profile permits an authorization no greater than `10000000` and a threshold no greater than the authorization.
5. Deploy, inspect health, and confirm the ledger initialized to exactly those values.
6. Treat every later runtime/ledger mismatch as an incident. Do not silently rewrite or raise an initialized ledger.

## Unknown provider outcome

1. Keep the run stopped and its reservation outstanding.
2. Do not replay the idempotency key and do not create a replacement step.
3. Use only the safe provider and client request identifiers to investigate.
4. Reconcile actual provider usage. Release or convert the reservation only through an explicit audited operator repair, not an automated retry.

## Cost guardrail or mismatch

1. Set `SWARM_LIVE_ENABLED=false`.
2. Preserve D1 and audit data.
3. Compare reconciled plus outstanding micro-USD to the OpenAI project usage view.
4. If pricing changed, update the versioned table, add boundary tests, and redeploy before further experiments.
5. Do not raise or repair the authorization without a new explicit deployment-owner decision and an audited change.

## Credential incident or rotation

1. Disable live execution.
2. Revoke the project-scoped key in OpenAI Platform.
3. Create a replacement with the narrow project and an expiry.
4. Update the hosted secret through the trusted control plane, never a source file or chat message.
5. Confirm Git, build archives, application logs, and audit metadata contain no credential material.
6. Run a no-charge Handoff Simulation smoke test before considering a new live experiment.

## Application rollback

1. Disable live execution.
2. Redeploy the deployment's recorded known-good Site version. Record its version, deployment ID, and source commit during the first successful private deployment; the public repository contains no prior deployment identifiers.
3. Leave additive D1 tables in place; do not drop data during an incident.
4. Verify sign-in, Handoff Simulation mode, and the live-mode lock on the rolled-back version.
5. Re-enable live experiments only after the cause is fixed and all P0 gates pass again.
