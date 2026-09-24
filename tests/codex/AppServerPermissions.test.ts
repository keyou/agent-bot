import { describe, expect, test } from "vitest";
import { workspaceSandboxFromConfig, workspaceSandboxFromResponse } from "../../src/codex/AppServerPermissions.js";

describe("App Server workspace sandbox policy", () => {
  const defaultPolicy = { type: "workspaceWrite", writableRoots: [], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false };

  test.each([{}, { sandbox_workspace_write: null }, { sandbox_workspace_write: {} }])("uses upstream defaults for absent workspace options", (config) => {
    expect(workspaceSandboxFromConfig(config)).toEqual(defaultPolicy);
  });

  test("preserves response options and copies writable roots", () => {
    const policy = { ...defaultPolicy, writableRoots: ["C:/extra"], excludeSlashTmp: true };
    const parsed = workspaceSandboxFromResponse(policy);
    expect(parsed).toEqual(policy);
    expect(parsed?.writableRoots).not.toBe(policy.writableRoots);
  });

  test.each([undefined, null, { type: "dangerFullAccess" }, { type: "readOnly", networkAccess: false },
    { ...defaultPolicy, writableRoots: [42] }, { ...defaultPolicy, networkAccess: "true" }])("does not treat other or malformed policies as workspace policies", (policy) => {
    expect(workspaceSandboxFromResponse(policy)).toBeUndefined();
  });

  test.each([undefined, null, { sandbox_workspace_write: [] }, { sandbox_workspace_write: { writable_roots: [42] } },
    { sandbox_workspace_write: { exclude_tmpdir_env_var: "false" } }])("rejects invalid config rather than silently weakening restrictions", (config) => {
    expect(() => workspaceSandboxFromConfig(config)).toThrow("无效的工作区沙箱配置");
  });
});
