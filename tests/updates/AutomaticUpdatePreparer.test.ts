import { afterEach, describe, expect, test, vi } from "vitest";
import { checkAutomaticUpdateSupport, prepareAutomaticUpdate, prepareSelectedUpdate } from "../../src/updates/AutomaticUpdatePreparer.js";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

afterEach(() => vi.unstubAllEnvs());

describe("automatic update preparation", () => {
  test("checks installation support in a separate process before starting a countdown", async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ status: "supported" }) }));
    await checkAutomaticUpdateSupport({ home: "profile", configPath: "config.yaml" }, run);
    expect(run).toHaveBeenCalledWith(process.execPath, [expect.stringContaining("AutomaticUpdatePreparer"), "--check"], expect.any(Object));
  });

  test("prepares in a hidden child with an explicit profile, without inheriting a task notification target", async () => {
    vi.stubEnv("AGENT_BOT", "1");
    const run = vi.fn(async (_file: string, _args: string[], _options: ExecFileOptionsWithStringEncoding) => (
      { stdout: JSON.stringify({ status: "prepared", planPath: "plan.json", targetVersion: "0.1.23" }) }
    ));
    await expect(prepareAutomaticUpdate("0.1.23", { home: "profile", configPath: "profile/config.yaml" }, run))
      .resolves.toEqual({ status: "prepared", planPath: "plan.json", targetVersion: "0.1.23" });
    expect(run).toHaveBeenCalledWith(process.execPath, [expect.stringContaining("AutomaticUpdatePreparer"), "0.1.23"], {
      env: expect.objectContaining({ AGENT_BOT_HOME: "profile", AGENT_BOT_CONFIG: "profile/config.yaml" }),
      windowsHide: true, encoding: "utf8", maxBuffer: 1_000_000,
    });
    expect(vi.mocked(run).mock.calls[0]?.[2].env?.AGENT_BOT).toBeUndefined();
    expect(process.env.AGENT_BOT).toBe("1");
  });

  test("never prepares prereleases or trusts a different version than the card announced", async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ status: "prepared", planPath: "plan.json", targetVersion: "0.1.24" }) }));
    const profile = { home: "profile", configPath: "profile/config.yaml" };
    await expect(prepareAutomaticUpdate("0.1.23-alpha.1", profile, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(prepareAutomaticUpdate("0.1.23", profile, run)).rejects.toThrow("announced version");
  });

  test("prepares an explicitly selected Alpha in a hidden child without permitting arbitrary package specs", async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ status: "prepared", planPath: "plan.json", targetVersion: "0.1.24-alpha.2" }) }));
    const profile = { home: "rescue-profile", configPath: "rescue-config.yaml" };
    await expect(prepareSelectedUpdate("0.1.24-alpha.2", profile, run)).resolves.toMatchObject({ status: "prepared", targetVersion: "0.1.24-alpha.2" });
    expect(run).toHaveBeenCalledWith(process.execPath, [expect.stringContaining("AutomaticUpdatePreparer"), "--manual", "0.1.24-alpha.2"], expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ AGENT_BOT_HOME: profile.home }) }));
    await expect(prepareSelectedUpdate("other-package@latest", profile, run)).rejects.toThrow();
    await expect(prepareSelectedUpdate("0.1.25", profile, run)).rejects.toThrow("selected version");
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("propagates installation guard and preparation failures without scheduling activation", async () => {
    const run = vi.fn(async () => { throw new Error("npm link installation cannot be updated"); });
    await expect(prepareAutomaticUpdate("0.1.23", { home: "profile", configPath: "config.yaml" }, run))
      .rejects.toThrow("npm link");
  });
});
