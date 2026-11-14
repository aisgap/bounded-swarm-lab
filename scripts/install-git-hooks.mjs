import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const trackedHooksDirectory = path.join(projectRoot, ".githooks");
const prePushHook = path.join(trackedHooksDirectory, "pre-push");

function runGit(args, { allowUnset = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
  });

  if (allowUnset && result.status === 1) {
    return "";
  }

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? "unknown Git error";
    throw new Error(`Unable to run git ${args.join(" ")}: ${detail}`);
  }

  return result.stdout.trim();
}

try {
  const repositoryRoot = realpathSync(
    runGit(["rev-parse", "--show-toplevel"]),
  );
  if (repositoryRoot !== projectRoot) {
    throw new Error(
      `Refusing to install hooks outside ${projectRoot}; Git reported ${repositoryRoot}.`,
    );
  }

  if (!statSync(prePushHook).isFile()) {
    throw new Error(`Tracked pre-push hook is missing at ${prePushHook}.`);
  }

  const configuredHooksPath = runGit(
    ["config", "--local", "--get", "core.hooksPath"],
    { allowUnset: true },
  );

  if (configuredHooksPath) {
    const resolvedConfiguredPath = realpathSync(
      path.resolve(projectRoot, configuredHooksPath),
    );
    if (resolvedConfiguredPath !== realpathSync(trackedHooksDirectory)) {
      throw new Error(
        `core.hooksPath is already set to ${configuredHooksPath}. It was not changed. ` +
          "Merge the existing hooks deliberately before trying again.",
      );
    }
  } else {
    const defaultHooksPathValue = runGit(["rev-parse", "--git-path", "hooks"]);
    const defaultHooksPath = path.resolve(projectRoot, defaultHooksPathValue);
    const existingHooks = readdirSync(defaultHooksPath, { withFileTypes: true })
      .filter((entry) => !entry.name.endsWith(".sample"))
      .map((entry) => entry.name);

    if (existingHooks.length > 0) {
      throw new Error(
        `Existing Git hooks were found (${existingHooks.join(", ")}). ` +
          "They were not replaced. Merge them into .githooks deliberately before trying again.",
      );
    }

    runGit(["config", "--local", "core.hooksPath", ".githooks"]);
  }

  chmodSync(prePushHook, 0o755);
  console.log("Installed the mandatory pre-push vulnerability gate from .githooks.");
  console.log("Every code push now requires both Trivy and Grype to pass.");
} catch (error) {
  console.error(`Git hook setup failed: ${error.message}`);
  process.exitCode = 1;
}
