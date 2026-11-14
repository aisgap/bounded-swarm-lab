import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const regeneratedDirectories = new Set([
  ".git", ".next", ".sites-runtime", ".wrangler", "coverage", "dist", "node_modules",
]);
const roots = process.argv.slice(2);
const candidateFiles = roots.length > 0
  ? roots.flatMap((root) => walk(root))
  : discoverPublishableFiles();

const patterns = [
  ["OpenAI key", /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/],
  ["populated API environment value", /OPENAI_API_KEY[ \t]*=[ \t]*[^\s#][^\r\n]*/],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

const findings = [];
for (const file of candidateFiles) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > MAX_TEXT_BYTES) continue;

  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length) {
  console.error("Potential secret material found in publishable files:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed for ${candidateFiles.length} publishable files.`);

function discoverPublishableFiles() {
  try {
    return execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    // Sanitized starter archives intentionally have no inherited Git history.
    // Scan the source tree directly while excluding regenerated local state.
    return walk(".", true);
  }
}

function walk(path, excludeRegenerated = false) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return [];
  }
  if (metadata.isSymbolicLink()) return [];
  if (metadata.isFile()) return [path];
  if (!metadata.isDirectory()) return [];
  if (excludeRegenerated && path !== "." && regeneratedDirectories.has(basename(path))) return [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => walk(join(path, entry.name), excludeRegenerated));
}
