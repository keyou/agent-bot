import { compareSemanticVersions } from "../utils/semanticVersion.js";

// Verified protocol baseline: paginated Turn summaries and excludeTurns.
export const MINIMUM_CODEX_VERSION = "0.153.4";

export class CodexVersionError extends Error {}

export function codexVersionIssue(version: string | undefined): string | undefined {
  if (version && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version)
    && compareSemanticVersions(version, MINIMUM_CODEX_VERSION) >= 0) return undefined;
  return `Codex ${version ?? "版本未知"} 不受支持，AgentBot 需要 Codex >= ${MINIMUM_CODEX_VERSION}。`
    + "请运行 codex update（或 npm install -g @openai/codex@latest）升级，然后安全重启 AgentBot。";
}

export function assertSupportedCodexVersion(version: string | undefined): void {
  const issue = codexVersionIssue(version);
  if (issue) throw new CodexVersionError(issue);
}
