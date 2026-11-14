# Security policy

## Supported versions

This project is pre-1.0 and experimental. Security fixes are made only on the latest commit of the default branch. Tagged preview releases may be superseded without backports.

## Reporting a vulnerability

Use the repository's **Report a vulnerability** flow to submit a private GitHub Security Advisory. Include the affected commit, reproduction steps using synthetic data, impact, and a proposed mitigation if known.

Do not open a public issue containing exploit details, credentials, provider bodies, task content, database exports, or live deployment identifiers. If private vulnerability reporting is unavailable, open a public issue with no sensitive detail asking the maintainers to enable a private reporting channel.

## Deployment trust boundary

The supported hosted configuration relies on OpenAI Sites to authenticate the visitor and inject `oai-authenticated-user-*` headers through trusted ingress. The application treats those headers as identity assertions.

Direct Worker deployment and arbitrary reverse-proxy deployment are unsupported unless the operator guarantees that:

- every client-supplied `oai-authenticated-user-*` header is stripped at the public edge;
- only a trusted authentication layer can add replacement identity headers; and
- the Worker cannot be reached through a path that bypasses that layer.

Failing to preserve this boundary can allow identity spoofing and cross-user data access.

## Credential or data incident

1. Set `SWARM_LIVE_ENABLED=false`.
2. Revoke the project-scoped provider key.
3. Preserve non-confidential audit identifiers and database state for investigation.
4. Do not retry a request with an unknown outcome.
5. Check Git history, build artifacts, logs, issue attachments, and deployment configuration for exposure.
6. Rotate affected credentials and complete a private Handoff Simulation smoke test before considering Live again.

Never send a credential to maintainers. Safe diagnostic material is limited to non-secret error codes, timestamps with time zone, source/deployment versions, and provider/client request identifiers.
