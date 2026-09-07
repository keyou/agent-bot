import { describe, expect, test, vi } from "vitest";
import {
  compareSemanticVersions,
  inspectSupportedAgents,
  runSupportedAgentMaintenance,
  selectAgentMaintenanceActions,
  type AgentCommandResult,
  type AgentCommandRunner,
  type SupportedAgentInspection,
} from "../../src/cli/AgentPrerequisites.js";

describe("inspectSupportedAgents", () => {
  test("checks the Codex minimum locally even when the registry is unavailable", async () => {
    const run = vi.fn(async (command: { display: string }) => command.display === "codex --version"
      ? successfulCommand("codex-cli 0.153.3") : failedCommand());
    const [codex] = await inspectSupportedAgents({ run });
    expect(codex).toMatchObject({
      state: "outdated", minimumVersion: "0.153.4",
      compatibilityIssue: expect.stringContaining("codex update"),
      action: { kind: "upgrade" },
    });
    expect(run.mock.calls.some(([command]) => command.display.startsWith("npm view"))).toBe(false);
  });

  test("reports missing agents with platform-specific installation commands", async () => {
    const run = vi.fn(async (): Promise<AgentCommandResult> => failedCommand());

    const agents = await inspectSupportedAgents({ platform: "win32", env: {}, run });

    expect(agents).toMatchObject([
      {
        id: "codex",
        state: "missing",
        action: { kind: "install", command: "npm install --global @openai/codex@latest" },
      },
      {
        id: "traex",
        state: "missing",
        action: { kind: "install" },
      },
    ]);
    expect(agents[1]?.action?.command).toContain("TRAEX_INSTALL_CHANNEL='alpha'");
  });

  test("detects old Codex and TraeX versions", async () => {
    const run: AgentCommandRunner = vi.fn(async (command) => {
      if (command.display === "codex --version") return successfulCommand("codex-cli 0.145.0\n");
      if (command.display.startsWith("npm view")) return successfulCommand('"0.146.0"\n');
      if (command.display === "traex --version") return successfulCommand("traecli 0.201.1-alpha.7(internal edition)\n");
      if (command.display === "traex update --channel alpha check") {
        return successfulCommand([
          "Current TraeCode CLI version: 0.201.1-alpha.7",
          "Latest TraeCode CLI version:  0.201.1-alpha.8",
          "Status: update available",
          "",
        ].join("\n"));
      }
      return failedCommand();
    });

    const agents = await inspectSupportedAgents({ platform: "linux", env: {}, run });

    expect(agents).toEqual([
      {
        id: "codex",
        name: "Codex",
        state: "outdated",
        installedVersion: "0.145.0",
        minimumVersion: "0.153.4",
        compatibilityIssue: expect.stringContaining("Codex >= 0.153.4"),
        action: { kind: "upgrade", command: "codex update" },
      },
      {
        id: "traex",
        name: "TraeX",
        state: "outdated",
        installedVersion: "0.201.1-alpha.7",
        latestVersion: "0.201.1-alpha.8",
        action: { kind: "upgrade", command: "traex update --channel alpha" },
      },
    ]);
  });

  test("keeps installed agents usable when the latest-version checks fail", async () => {
    const run: AgentCommandRunner = vi.fn(async (command) => {
      if (command.display === "codex --version") return successfulCommand("codex-cli 0.153.4\n");
      if (command.display === "traex --version") return successfulCommand("traecli 0.201.1-alpha.8\n");
      return failedCommand();
    });

    await expect(inspectSupportedAgents({ platform: "linux", env: {}, run })).resolves.toEqual([
      {
        id: "codex",
        name: "Codex",
        state: "ready",
        installedVersion: "0.153.4",
        latestCheckFailed: true,
      },
      {
        id: "traex",
        name: "TraeX",
        state: "ready",
        installedVersion: "0.201.1-alpha.8",
        latestCheckFailed: true,
      },
    ]);
  });
});

describe("runSupportedAgentMaintenance", () => {
  test("runs the supported updater command with inherited stdio", async () => {
    const run = vi.fn(async (): Promise<AgentCommandResult> => successfulCommand());

    await runSupportedAgentMaintenance("traex", "upgrade", { platform: "linux", env: {}, run });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: "traex",
      args: ["update", "--channel", "alpha"],
      inheritStdio: true,
    }));
  });

  test("uses the Codex updater when it succeeds", async () => {
    const run = vi.fn(async (): Promise<AgentCommandResult> => successfulCommand());

    await runSupportedAgentMaintenance("codex", "upgrade", { platform: "win32", env: {}, run });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: "codex",
      args: ["update"],
      inheritStdio: true,
    }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("falls back to the npm package when an old Codex updater fails", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(failedCommand())
      .mockResolvedValueOnce(successfulCommand());

    await runSupportedAgentMaintenance("codex", "upgrade", { platform: "win32", env: {}, run });

    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: "npm",
      args: ["install", "--global", "@openai/codex@latest"],
      inheritStdio: true,
    }));
  });
});

describe("selectAgentMaintenanceActions", () => {
  test("offers installations when no supported Agent is installed", () => {
    const inspections = [
      missingAgent("codex", "Codex"),
      missingAgent("traex", "TraeX"),
    ];

    expect(selectAgentMaintenanceActions(inspections)).toEqual(inspections);
  });

  test("does not offer another Agent installation when one is already installed", () => {
    const inspections: SupportedAgentInspection[] = [
      {
        id: "codex",
        name: "Codex",
        state: "ready",
        installedVersion: "0.146.0",
        latestVersion: "0.146.0",
      },
      missingAgent("traex", "TraeX"),
    ];

    expect(selectAgentMaintenanceActions(inspections)).toEqual([]);
  });

  test("keeps upgrades for installed Agents while hiding missing Agent installations", () => {
    const codex: SupportedAgentInspection = {
      id: "codex",
      name: "Codex",
      state: "outdated",
      installedVersion: "0.145.0",
      latestVersion: "0.146.0",
      action: { kind: "upgrade", command: "codex update" },
    };

    expect(selectAgentMaintenanceActions([
      codex,
      missingAgent("traex", "TraeX"),
    ])).toEqual([codex]);
  });
});

describe("compareSemanticVersions", () => {
  test("orders stable and prerelease semantic versions", () => {
    expect(compareSemanticVersions("0.146.0", "0.145.9")).toBeGreaterThan(0);
    expect(compareSemanticVersions("0.201.1-alpha.7", "0.201.1-alpha.8")).toBeLessThan(0);
    expect(compareSemanticVersions("0.201.1", "0.201.1-alpha.8")).toBeGreaterThan(0);
    expect(compareSemanticVersions("0.201.1-alpha.8", "0.201.1-alpha.8")).toBe(0);
  });
});

function successfulCommand(stdout = ""): AgentCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function failedCommand(): AgentCommandResult {
  return { status: 1, stdout: "", stderr: "not found" };
}

function missingAgent(
  id: "codex" | "traex",
  name: string,
): SupportedAgentInspection {
  return {
    id,
    name,
    state: "missing",
    action: { kind: "install", command: `install-${id}` },
  };
}
