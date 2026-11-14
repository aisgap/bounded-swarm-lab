# Known limitations

This snapshot is suitable for a private, supervised pilot. It is not yet suitable for unattended or confidential daily work.

Do not enable live execution until the owner understands and accepts all of the following:

- The whole-run deadline is 60 seconds from run creation, which is too short for a normal manual multi-step work session.
- The current interface shows short agent records, not a complete final export with all findings, evidence, and uncertainty.
- There is no user-facing run history, deletion workflow, or retention control.
- An ambiguous provider outcome safely blocks further provider work until an operator reconciles it; there is no self-service repair screen.
- The public ledger starts at $0. A deployment owner must explicitly configure any pilot authorization and threshold; the included profile permits no more than $10, which is not an ongoing operating budget.
- The pricing table is versioned in source and must be checked against current provider prices before each release.
- Inputs and outputs may contain work information. Keep the Site owner-private and do not enter confidential material until retention, deletion, and support responsibilities are agreed.

Before daily use, complete every P1 item in `docs/acceptance.md`, run a controlled pilot with non-confidential tasks, and document a support and rollback owner.
