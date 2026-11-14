## Summary

Describe the problem and the smallest change that solves it.

## Safety impact

- [ ] Live execution remains disabled by default.
- [ ] The change does not add credentials, confidential task content, provider bodies, or deployment identifiers to source, tests, fixtures, or logs.
- [ ] Provider calls remain manually initiated, bounded, single-concurrency, and free of automatic retries.
- [ ] Cost reservations and ambiguous outcomes remain fail-closed.
- [ ] Database changes are additive and have a documented rollback path, or this change does not affect the database.

## Verification

- [ ] `npm run check` passes locally.
- [ ] The local pre-push Trivy and Grype vulnerability scan passes.
- [ ] The required GitHub Trivy and Grype checks pass.
- [ ] New or changed behavior has deterministic tests, including relevant failure paths.
- [ ] Documentation and known limitations are updated where needed.
- [ ] No real OpenAI API call was used to validate this pull request.

## Evidence

List the tests run and any non-sensitive screenshots or receipts reviewers should inspect.
