# Mandatory vulnerability scanning

Every code push is checked by two independent vulnerability scanners: [Trivy](https://trivy.dev/) and [Grype](https://github.com/anchore/grype). Both must complete successfully and report no `HIGH` or `CRITICAL` dependency vulnerabilities.

The policy includes vulnerabilities without a published fix. There is no repository ignore list. A temporary waiver must not be implemented by weakening or bypassing these commands; handle exceptional risk decisions through a documented security review and a separately reviewed policy change.

## One-time local setup

Install Trivy and Grype from their verified vendor packages or releases. Do not pipe an unaudited remote install script into a shell. On macOS with Homebrew:

```text
brew install trivy grype
```

Verify both commands, then activate the repository-owned hook:

```text
trivy --version
grype version
npm run hooks:install
```

The checked-in policy currently requires Trivy 0.76.2 or newer and Grype 0.121.3 or newer. GitHub uses those exact reviewed versions; local versions may be newer but cannot be older.

The installer refuses to replace a custom `core.hooksPath` or any existing non-sample hook. Merge existing hooks deliberately if it reports a conflict.

## What happens before a push

The pre-push hook:

1. rejects a dirty working tree so the scanned files exactly match the commit;
2. rejects pushing a branch or tag that is not the checked-out `HEAD`;
3. requires both scanner executables to be installed;
4. updates and validates the scanners' vulnerability data;
5. runs the scanners sequentially, with a 4.5-minute maximum per scanner; and
6. blocks the push if either scanner errors, times out, cannot update, or finds a `HIGH` or `CRITICAL` issue.

Push multiple branches by checking out and pushing each branch separately. Ref deletion does not introduce code and therefore does not trigger a scan.

Run the same local gate at any time with:

```text
npm run security:scan
```

## Remediation

If a scan fails:

- update the affected direct dependency and regenerate `package-lock.json` with the approved package manager;
- use `npm explain <package>` to find the direct dependency that introduces a vulnerable transitive package;
- rerun the full test and build gate after changing dependencies;
- do not add ignore rules or use `git push --no-verify`; and
- if scanner data cannot update, restore network access or wait for the vendor service instead of relying on stale data.

The local hook can technically be bypassed by Git itself. The repository's required Trivy and Grype GitHub checks are therefore the authoritative enforcement layer for the protected default branch. Maintainers must configure both checks as required and disallow direct bypasses.

Require these exact status checks in the `main` ruleset after their first successful run:

- `Vulnerability Scans / Trivy (HIGH and CRITICAL)`
- `Vulnerability Scans / Grype (HIGH and CRITICAL)`

The ruleset must require pull requests, apply to administrators, and allow no direct-push or status-check bypass. The workflow also runs on merge queues and a weekly schedule so new vulnerability intelligence is detected even when the source does not change.
