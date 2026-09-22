import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  compareSemver,
  finalizeSelfUpdatePlan,
  defaultUpdateChannel,
  inspectNpmInstallation,
  parseSelfUpdateOptions,
  prepareSelfUpdate,
  readPendingSelfUpdate,
  type SelfUpdaterDependencies,
} from "../../src/cli/SelfUpdater.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("self-update options", () => {
  test("parses release channel, task, JSON, and downgrade confirmation", () => {
    expect(
      parseSelfUpdateOptions([
        "--alpha",
        "--task",
        "7",
        "--allow-downgrade",
        "--json",
      ]),
    ).toEqual({
      channel: "alpha",
      taskReference: "7",
      allowDowngrade: true,
      json: true,
    });
  });

  test("rejects conflicting release selectors", () => {
    expect(() => parseSelfUpdateOptions(["--alpha", "--stable"])).toThrow(
      "cannot be combined",
    );
    expect(() =>
      parseSelfUpdateOptions(["--version", "1.2.3", "--alpha"]),
    ).toThrow("cannot be combined");
  });
});

describe("npm installation detection", () => {
  test("accepts a real global npm package directory", () => {
    const root = temporaryDirectory();
    const globalRoot = path.join(root, "global", "node_modules");
    const packageRoot = path.join(globalRoot, "@keyou007", "agent-bot");
    fs.mkdirSync(packageRoot, { recursive: true });

    expect(
      inspectNpmInstallation(packageRoot, () => command(globalRoot)),
    ).toEqual({
      kind: "global",
      packageRoot: fs.realpathSync.native(packageRoot),
    });
  });

  test("identifies npm link without following it as a managed install", () => {
    const root = temporaryDirectory();
    const sourceRoot = path.join(root, "source");
    const globalRoot = path.join(root, "global", "node_modules");
    const linkedRoot = path.join(globalRoot, "@keyou007", "agent-bot");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(
      sourceRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(
      inspectNpmInstallation(sourceRoot, () => command(globalRoot)).kind,
    ).toBe("linked");
  });
});

describe("self-update preparation", () => {
  test("stages and validates the candidate before creating an update plan", async () => {
    const root = temporaryDirectory();
    const globalRoot = path.join(root, "global", "node_modules");
    const packageRoot = path.join(globalRoot, "@keyou007", "agent-bot");
    const home = path.join(root, "home");
    const runnerEntry = path.join(root, "SelfUpdateRunner.js");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@keyou007/agent-bot",
        version: "1.2.3-alpha.1",
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// cli");
    fs.writeFileSync(
      path.join(packageRoot, "dist", "supervisor.js"),
      "// supervisor",
    );
    fs.writeFileSync(runnerEntry, "// runner");
    const validatePackage = vi.fn();
    const runNpm = vi.fn((args: string[]) => {
      if (args[0] === "root") return command(globalRoot);
      if (args[0] === "view") return command('"1.2.3-alpha.2"');
      if (args[0] === "pack") {
        const destination = args[args.indexOf("--pack-destination") + 1]!;
        const filename =
          args[1] === packageRoot ? "agent-bot-old.tgz" : "agent-bot-new.tgz";
        fs.writeFileSync(path.join(destination, filename), "archive");
        return command(filename);
      }
      if (args[0] === "install") return command("");
      throw new Error(`Unexpected npm command: ${args.join(" ")}`);
    });
    const dependencies: SelfUpdaterDependencies = {
      packageRoot,
      home,
      runnerEntry,
      runNpm,
      validatePackage,
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      randomId: () => "operation",
    };

    const result = await prepareSelfUpdate({}, dependencies);

    expect(result).toMatchObject({
      status: "prepared",
      currentVersion: "1.2.3-alpha.1",
      targetVersion: "1.2.3-alpha.2",
      channel: "alpha",
    });
    if (result.status !== "prepared")
      throw new Error("Expected a prepared update.");
    expect(fs.existsSync(result.planPath)).toBe(true);
    expect(fs.existsSync(result.runnerPath)).toBe(true);
    expect(readPendingSelfUpdate(home)).toMatchObject({
      planPath: result.planPath,
      plan: { fromVersion: "1.2.3-alpha.1", toVersion: "1.2.3-alpha.2" },
    });
    expect(validatePackage).toHaveBeenCalledTimes(2);
    expect(
      runNpm.mock.calls.find(([args]) => args[0] === "install"),
    ).toBeTruthy();
  });

  test("refuses a linked source checkout before checking the registry", async () => {
    const root = temporaryDirectory();
    const sourceRoot = path.join(root, "source");
    const globalRoot = path.join(root, "global", "node_modules");
    const linkedRoot = path.join(globalRoot, "@keyou007", "agent-bot");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(
      sourceRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const runNpm = vi.fn(() => command(globalRoot));

    await expect(
      prepareSelfUpdate(
        {},
        {
          packageRoot: sourceRoot,
          home: path.join(root, "home"),
          runnerEntry: path.join(root, "runner.js"),
          runNpm,
          validatePackage: vi.fn(),
          now: () => new Date(),
          randomId: () => "operation",
        },
      ),
    ).rejects.toThrow("npm link");
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  test("rejects a second update for the same global npm package", async () => {
    const root = temporaryDirectory();
    const globalRoot = path.join(root, "global", "node_modules");
    const packageRoot = path.join(globalRoot, "@keyou007", "agent-bot");
    const lockPath = path.join(globalRoot, ".agent-bot-update.lock");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ token: "another-update", phase: "prepared" }),
    );
    const runNpm = vi.fn((args: string[]) =>
      args[0] === "root" ? command(globalRoot) : command('"1.2.4"'),
    );

    await expect(
      prepareSelfUpdate(
        {},
        {
          packageRoot,
          home: path.join(root, "home"),
          runnerEntry: path.join(root, "runner.js"),
          runNpm,
          validatePackage: vi.fn(),
          now: () => new Date(),
          randomId: () => "operation",
        },
      ),
    ).rejects.toThrow("already prepared or running");
    expect(fs.readFileSync(lockPath, "utf8")).toContain("another-update");
  });
});

describe("semantic version ordering", () => {
  test.each([
    ["1.2.4", "1.2.3", 1],
    ["1.2.3", "1.2.3", 0],
    ["1.2.3-alpha.2", "1.2.3-alpha.1", 1],
    ["1.2.3", "1.2.3-alpha.9", 1],
    ["1.2.3-alpha.1", "1.2.3", -1],
  ])("compares %s with %s", (left, right, expected) => {
    expect(compareSemver(left, right)).toBe(expected);
  });

  test("keeps prerelease installations on alpha by default", () => {
    expect(defaultUpdateChannel("1.2.3-alpha.1")).toBe("alpha");
    expect(defaultUpdateChannel("1.2.3")).toBe("latest");
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-bot-self-update-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function command(stdout: string, status = 0) {
  return { status, stdout: `${stdout}\n`, stderr: "" };
}


describe("self-update notification routing", () => {
  test("preserves the initiating group or topic in the prepared plan for recovery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-update-target-"));
    temporaryDirectories.push(directory);
    const planPath = path.join(directory, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify({ fromVersion: "0.1.23", toVersion: "0.1.24-alpha.1" }));
    const notificationTarget = { contextKey: "chat_id:group:thread_id:topic", replyMessageId: "update-card" };
    finalizeSelfUpdatePlan(planPath, { controlEndpoint: "endpoint", databasePath: "state.sqlite", restartService: true, notificationTarget });
    expect(JSON.parse(fs.readFileSync(planPath, "utf8"))).toMatchObject({ fromVersion: "0.1.23", toVersion: "0.1.24-alpha.1", notificationTarget, restartService: true });
  });
});
