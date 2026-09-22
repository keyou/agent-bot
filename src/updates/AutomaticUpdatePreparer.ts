import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config/loadConfig.js";
import { controlEndpoint } from "../cli/controlProtocol.js";
import { finalizeSelfUpdatePlan, prepareSelfUpdate, releaseSelfUpdatePlan, requireNpmSelfUpdateInstallation } from "../cli/SelfUpdater.js";
import { publishedVersionSchema, stableVersionSchema } from "./PublishedRelease.js";

const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("current") }),
  z.object({ status: z.literal("prepared"), planPath: z.string().min(1), targetVersion: publishedVersionSchema }),
]);
const runFile = promisify(execFile);
type RunPreparation = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;
interface UpdateProfile { home: string; configPath: string }

export async function checkAutomaticUpdateSupport(profile: UpdateProfile, run: RunPreparation = runFile): Promise<void> {
  z.object({ status: z.literal("supported") }).parse(await runPreparer("--check", profile, run));
}

export async function prepareAutomaticUpdate(
  version: string,
  profile: UpdateProfile,
  run: RunPreparation = runFile,
): Promise<z.infer<typeof resultSchema>> {
  stableVersionSchema.parse(version);
  const result = resultSchema.parse(await runPreparer(version, profile, run));
  if (result.status === "prepared" && result.targetVersion !== version) {
    throw new Error("The prepared update does not match the announced version.");
  }
  return result;
}

export async function prepareSelectedUpdate(
  version: string,
  profile: UpdateProfile,
  run: RunPreparation = runFile,
): Promise<z.infer<typeof resultSchema>> {
  publishedVersionSchema.parse(version);
  const result = resultSchema.parse(await runPreparer("--manual", profile, run, version));
  if (result.status === "prepared" && result.targetVersion !== version) {
    throw new Error("The prepared update does not match the selected version.");
  }
  return result;
}

async function runPreparer(argument: string, profile: UpdateProfile, run: RunPreparation, version?: string): Promise<unknown> {
  const environment: NodeJS.ProcessEnv = { ...process.env, AGENT_BOT_HOME: profile.home, AGENT_BOT_CONFIG: profile.configPath };
  delete environment.AGENT_BOT;
  // npm preparation is synchronous and can take minutes; keep it off the live worker's event loop.
  const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.url), argument, ...(version ? [version] : [])], {
    env: environment, windowsHide: true, encoding: "utf8", maxBuffer: 1_000_000,
  });
  return JSON.parse(String(stdout)) as unknown;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--check") {
    requireNpmSelfUpdateInstallation();
    process.stdout.write(JSON.stringify({ status: "supported" }));
    return;
  }
  const manual = process.argv[2] === "--manual";
  const version = manual ? publishedVersionSchema.parse(process.argv[3]) : stableVersionSchema.parse(process.argv[2]);
  const config = loadConfig();
  const prepared = await prepareSelfUpdate({ version });
  if (prepared.status === "prepared") {
    try {
      finalizeSelfUpdatePlan(prepared.planPath, {
        controlEndpoint: controlEndpoint(config.storage.sqlitePath),
        databasePath: config.storage.sqlitePath,
        restartService: true,
        workingDirectory: process.cwd(),
        reason: `Agent Bot ${manual ? "更新" : "自动更新"}到 ${version}`,
      });
    } catch (error) {
      releaseSelfUpdatePlan(prepared.planPath);
      throw error;
    }
  }
  process.stdout.write(JSON.stringify(prepared));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
