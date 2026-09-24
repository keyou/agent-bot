import { z } from "zod";

const workspacePolicySchema = z.object({
  type: z.literal("workspaceWrite"),
  writableRoots: z.array(z.string().min(1)),
  networkAccess: z.boolean(),
  excludeTmpdirEnvVar: z.boolean(),
  excludeSlashTmp: z.boolean(),
});

const workspaceConfigSchema = z.object({
  sandbox_workspace_write: z.object({
    writable_roots: z.array(z.string().min(1)).default([]),
    network_access: z.boolean().default(false),
    exclude_tmpdir_env_var: z.boolean().default(false),
    exclude_slash_tmp: z.boolean().default(false),
  }).nullish(),
});

export type WorkspaceSandboxPolicy = z.infer<typeof workspacePolicySchema>;
export type TurnSandboxPolicy = WorkspaceSandboxPolicy | { type: "dangerFullAccess" };

export function workspaceSandboxFromResponse(sandbox: unknown): WorkspaceSandboxPolicy | undefined {
  const parsed = workspacePolicySchema.safeParse(sandbox);
  return parsed.success ? parsed.data : undefined;
}

export function workspaceSandboxFromConfig(config: unknown): WorkspaceSandboxPolicy {
  const parsed = workspaceConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error("App Server 返回了无效的工作区沙箱配置，未启动新轮次。");
  const settings = parsed.data.sandbox_workspace_write;
  return {
    type: "workspaceWrite",
    writableRoots: settings?.writable_roots ?? [],
    networkAccess: settings?.network_access ?? false,
    excludeTmpdirEnvVar: settings?.exclude_tmpdir_env_var ?? false,
    excludeSlashTmp: settings?.exclude_slash_tmp ?? false,
  };
}
