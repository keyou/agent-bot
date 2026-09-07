import { describe, expect, test } from "vitest";
import {
  parseMaintenanceSelection,
  resolveAgentConfigurationChoices,
  resolveDefaultAgentChoice,
  selectableDefaultAgents,
} from "../../src/cli/DefaultAgentSelection.js";

describe("selectableDefaultAgents", () => {
  test("omits an installed Codex that does not satisfy the protocol minimum", () => {
    expect(selectableDefaultAgents([{ name: "codex", title: "Codex" }], [{
      id: "codex", name: "Codex", state: "outdated", installedVersion: "0.153.3",
      compatibilityIssue: "Upgrade Codex", minimumVersion: "0.153.4",
    }])).toEqual([]);
  });

  test("keeps detected installed Agents while omitting missing and custom Agents", () => {
    expect(selectableDefaultAgents([
      { name: "codex", title: "Codex" },
      { name: "traex", title: "TraeX" },
      { name: "custom", title: "Custom Agent" },
    ], [
      {
        id: "codex",
        name: "Codex",
        state: "ready",
        installedVersion: "0.146.0",
      },
      {
        id: "traex",
        name: "TraeX",
        state: "missing",
        action: { kind: "install", command: "install-traex" },
      },
    ])).toEqual([
      { name: "codex", title: "Codex", installedVersion: "0.146.0" },
    ]);
  });
});

describe("resolveAgentConfigurationChoices", () => {
  const choices = [
    { name: "codex", title: "Codex", installedVersion: "0.146.0" },
    { name: "traex", title: "TraeX", installedVersion: "0.201.1-alpha.8" },
  ];

  test("accepts numbers, standard names, all, and an empty all selection", () => {
    expect(resolveAgentConfigurationChoices("2, codex", choices)).toEqual([0, 1]);
    expect(resolveAgentConfigurationChoices("TRaEx", choices)).toEqual([1]);
    expect(resolveAgentConfigurationChoices("all", choices)).toEqual([0, 1]);
    expect(resolveAgentConfigurationChoices("", choices)).toEqual([0, 1]);
    expect(resolveAgentConfigurationChoices("missing", choices)).toBeUndefined();
  });
});

describe("parseMaintenanceSelection", () => {
  test("accepts comma-separated choices, all, and an empty skip", () => {
    expect(parseMaintenanceSelection("2, 1,2", 2)).toEqual([0, 1]);
    expect(parseMaintenanceSelection("1，2", 2)).toEqual([0, 1]);
    expect(parseMaintenanceSelection("all", 2)).toEqual([0, 1]);
    expect(parseMaintenanceSelection("", 2)).toEqual([]);
    expect(parseMaintenanceSelection("3", 2)).toBeUndefined();
  });
});

describe("resolveDefaultAgentChoice", () => {
  const choices = [
    { name: "codex", title: "Codex", installedVersion: "0.146.0" },
    { name: "traex", title: "TraeX", installedVersion: "0.201.1-alpha.8" },
  ];

  test("accepts a number, a standard name, or an empty current selection", () => {
    expect(resolveDefaultAgentChoice("2", choices, "codex")).toBe(1);
    expect(resolveDefaultAgentChoice("TRaEx", choices, "codex")).toBe(1);
    expect(resolveDefaultAgentChoice("", choices, "codex")).toBe(0);
    expect(resolveDefaultAgentChoice("", choices, "missing")).toBeUndefined();
    expect(resolveDefaultAgentChoice("unknown", choices, "codex")).toBeUndefined();
  });
});
