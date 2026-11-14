# Contributing

Bounded Swarm Lab is an experimental safety-oriented project. Contributions are welcome, but changes that weaken deterministic limits, cost controls, authentication boundaries, or failure handling will not be accepted without corresponding tests and documentation.

## Before opening a change

- Read `docs/architecture.md`, `docs/known-limitations.md`, and `docs/acceptance.md`.
- Do not include API keys, environment files, live Site or database identifiers, task content, provider responses, customer data, or screenshots containing confidential information.
- Use synthetic fixtures. Automated tests must not make provider calls or require secrets.
- Discuss large workflow, persistence, authentication, or budget-model changes in an issue before implementation.

## Local checks

Use Node.js 22.13 or newer. Install the locked dependency set, then run the complete gate:

```text
npm run install:ci
npm run hooks:install
npm run check
npm run security:scan
```

`npm run check` scans source files for secrets, runs the deterministic test suite, performs strict type checking, builds the production artifact, and scans the artifact again.

The one-time hook setup makes both Trivy and Grype mandatory before every code push. Missing tools, stale or unavailable vulnerability data, scanner errors, timeouts, and `HIGH` or `CRITICAL` findings all block the push. See `docs/security-scanning.md` for verified installation guidance, exact enforcement behavior, and remediation steps.

Changes should include failure-path and boundary tests where applicable. Provider behavior must be tested with local fakes; never add a real credential to CI.

## Pull requests

Keep pull requests focused and describe:

- the problem and intended behavior;
- safety or privacy implications;
- tests added or updated;
- migration and rollback impact; and
- any operational documentation that changed.

Database migrations must be additive. Do not include destructive rollback SQL. Price-table changes must cite the effective provider pricing version in the pull-request description and include boundary tests.

By contributing, you agree that your contribution may be distributed under the repository's license.

## Security reports

Do not report vulnerabilities or exposed secrets in a public issue. Follow `SECURITY.md`.
