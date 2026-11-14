import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const scannerTimeoutMs = 270_000;
const minimumScannerVersions = {
  trivy: "0.76.2",
  grype: "0.121.3",
};

function parseTarget(argv) {
  if (argv.length === 0) {
    return projectRoot;
  }

  if (argv.length !== 2 || argv[0] !== "--target") {
    throw new Error("Usage: node scripts/security/scan-vulnerabilities.mjs [--target PATH]");
  }

  const candidate = realpathSync(path.resolve(projectRoot, argv[1]));
  if (!statSync(candidate).isDirectory()) {
    throw new Error(`Scan target is not a directory: ${candidate}`);
  }

  return candidate;
}

function scannerEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("GRYPE_") && !name.startsWith("TRIVY_"),
    ),
  );

  return {
    ...environment,
    GRYPE_CHECK_FOR_APP_UPDATE: "false",
    GRYPE_DB_AUTO_UPDATE: "true",
    GRYPE_DB_REQUIRE_UPDATE_CHECK: "true",
    GRYPE_DB_VALIDATE_AGE: "true",
    GRYPE_DB_VALIDATE_BY_HASH_ON_START: "true",
    GRYPE_ONLY_FIXED: "false",
  };
}

function verifyScanner(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: scannerEnvironment(),
  });

  if (result.error?.code === "ENOENT") {
    throw new Error(
      `${command} is required but was not found on PATH. ` +
        "Install it from the vendor's verified package or release, then retry the push.",
    );
  }

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? "version check failed";
    throw new Error(`${command} is unavailable: ${detail}`);
  }

  const firstLine = result.stdout.trim().split("\n")[0];
  const versionMatch = result.stdout.match(/\b(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!versionMatch) {
    throw new Error(`${command} returned an unrecognized version: ${firstLine}`);
  }

  const installedParts = versionMatch[1].split(".").map(Number);
  const minimumParts = minimumScannerVersions[command].split(".").map(Number);
  const isSupported = installedParts.some((part, index) => {
    const previousPartsMatch = installedParts
      .slice(0, index)
      .every((previousPart, previousIndex) => previousPart === minimumParts[previousIndex]);
    return previousPartsMatch && part > minimumParts[index];
  }) || installedParts.every((part, index) => part === minimumParts[index]);

  if (!isSupported) {
    throw new Error(
      `${command} ${versionMatch[1]} is too old; version ${minimumScannerVersions[command]} or newer is required.`,
    );
  }

  console.log(`${command}: ${versionMatch[1]} (minimum ${minimumScannerVersions[command]})`);
}

function runScanner(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: scannerTimeoutMs,
    killSignal: "SIGTERM",
    env: scannerEnvironment(),
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${label} exceeded its 4.5-minute time limit.`);
  }

  if (result.error) {
    throw new Error(`${label} could not run: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `${label} failed. Resolve every HIGH or CRITICAL finding (including unfixed findings) ` +
        "and ensure its vulnerability database can update before retrying.",
    );
  }
}

try {
  const target = parseTarget(process.argv.slice(2));
  for (const requiredFile of ["package.json", "package-lock.json"]) {
    if (!existsSync(path.join(target, requiredFile))) {
      throw new Error(`Refusing incomplete scan: ${requiredFile} is missing from ${target}.`);
    }
  }

  const availabilityFailures = [];
  for (const command of ["trivy", "grype"]) {
    try {
      verifyScanner(command);
    } catch (error) {
      availabilityFailures.push(error.message);
    }
  }
  if (availabilityFailures.length > 0) {
    throw new Error(availabilityFailures.join(" "));
  }

  const scans = [
    {
      label: "Trivy filesystem vulnerability scan",
      command: "trivy",
      args: [
        "--config",
        path.join(projectRoot, "scripts/security/trivy.yaml"),
        "fs",
        "--ignorefile",
        "",
        "--no-progress",
        "--disable-telemetry",
        "--skip-version-check",
        "--timeout",
        "4m0s",
        target,
      ],
    },
    {
      label: "Grype filesystem vulnerability scan",
      command: "grype",
      args: [
        "--config",
        path.join(projectRoot, "scripts/security/grype.yaml"),
        `dir:${target}`,
        "--fail-on",
        "high",
        "--output",
        "table",
      ],
    },
  ];

  const scanFailures = [];
  for (const scan of scans) {
    try {
      runScanner(scan.label, scan.command, scan.args);
    } catch (error) {
      scanFailures.push(error.message);
    }
  }
  if (scanFailures.length > 0) {
    throw new Error(scanFailures.join(" "));
  }

  console.log("\nMandatory vulnerability gate passed: Trivy and Grype found no HIGH or CRITICAL issues.");
} catch (error) {
  console.error(`\nMandatory vulnerability gate failed: ${error.message}`);
  process.exitCode = 1;
}
