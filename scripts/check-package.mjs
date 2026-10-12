import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const npmExecutable = process.env.npm_execpath;
const npmCommand = npmExecutable ? process.execPath : "npm";
const npmArguments = npmExecutable
  ? [npmExecutable, "pack", "--dry-run", "--json", "--ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const result = spawnSync(npmCommand, npmArguments, {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  shell: !npmExecutable && process.platform === "win32",
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const manifests = JSON.parse(result.stdout);
const manifest = manifests[0];
if (!manifest) {
  throw new Error("npm pack did not return a package manifest.");
}

const packagedFiles = new Set(manifest.files.map((entry) => entry.path));
const requiredFiles = [
  ".env.example",
  "assets/agent-bot-logo.png",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh.md",
  "SECURITY.md",
  "config.example.yaml",
  "dist/cli.js",
  "dist/deprecated-cli.js",
  "dist/cli/SelfUpdateRunner.js",
  "dist/index.js",
  "dist/terminal/TerminalServer.js",
  "dist/terminal/TerminalPage.js",
  "dist/terminal/TerminalProcess.js",
  "dist/supervisor.js",
  "docs/technical-reference.md",
  "docs/technical-reference.zh.md",
  "skills/agent-bot/SKILL.md",
  "src/cli.ts",
  "tsconfig.json",
];
const missingFiles = requiredFiles.filter((file) => !packagedFiles.has(file));
if (missingFiles.length > 0) {
  throw new Error(
    `Package is missing required files: ${missingFiles.join(", ")}`,
  );
}

const forbiddenPrefixes = [
  ".github/",
  ".tmp/",
  ".worktrees/",
  "docs/plans/",
  "docs/specs/",
  "examples/",
  "node_modules/",
  "scripts/",
  "tests/",
];
const forbiddenFiles = new Set(["AGENTS.md", "plan.md", "tsconfig.test.json"]);
const unexpectedFiles = manifest.files
  .map((entry) => entry.path)
  .filter(
    (file) =>
      forbiddenFiles.has(file) ||
      forbiddenPrefixes.some((prefix) => file.startsWith(prefix)),
  );
if (unexpectedFiles.length > 0) {
  throw new Error(
    `Package contains development-only files: ${unexpectedFiles.join(", ")}`,
  );
}

const expectedBins = {
  agentbot: "dist/cli.js",
  "agent-bot": "dist/deprecated-cli.js",
};
if (JSON.stringify(packageJson.bin) !== JSON.stringify(expectedBins)) {
  throw new Error("Package CLI entries do not match the supported agentbot and deprecated agent-bot commands.");
}

for (const entry of Object.values(expectedBins)) {
  const contents = fs.readFileSync(path.join(repositoryRoot, entry), "utf8");
  if (!contents.startsWith("#!/usr/bin/env node")) {
    throw new Error(`${entry} must retain its Node.js shebang.`);
  }
}

process.stdout.write(
  `Package ${manifest.name}@${manifest.version}: ${manifest.entryCount} files, ${manifest.unpackedSize} unpacked bytes\n`,
);
