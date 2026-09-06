import fs from "node:fs";
import path from "node:path";
import { isMap, parseDocument } from "yaml";
import type { AgentExecutionDefaults } from "./schema.js";

const DEFAULT_KEYS = ["modelProvider", "model", "reasoningEffort", "permissionMode"] as const;

export function writeAgentExecutionDefaults(
  configPath: string,
  agentName: string,
  defaults: AgentExecutionDefaults,
): boolean {
  const original = fs.readFileSync(configPath, "utf8");
  const document = parseDocument(original);
  if (document.errors.length > 0) {
    throw new Error(`Could not update configuration file ${configPath}: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }
  if (!isMap(document.contents)) {
    throw new Error(`Configuration file must contain a YAML mapping: ${configPath}`);
  }
  const agent = document.getIn(["agents", agentName], true);
  if (!isMap(agent)) {
    throw new Error(`Cannot save defaults for an Agent that is not configured: ${agentName}`);
  }
  const existingDefaults = agent.get("defaults", true);
  if (existingDefaults !== undefined && !isMap(existingDefaults)) {
    throw new Error(`Configuration agents.${agentName}.defaults must contain a YAML mapping: ${configPath}`);
  }
  if (!isMap(existingDefaults)) agent.set("defaults", document.createNode({}));
  const target = agent.get("defaults", true);
  if (!isMap(target)) throw new Error(`Could not create defaults for Agent: ${agentName}`);

  for (const key of DEFAULT_KEYS) {
    const value = defaults[key];
    if (value !== undefined) target.set(key, value);
  }

  const updated = document.toString();
  if (updated === original) return false;
  writeFileAtomically(configPath, updated);
  return true;
}

function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let temporaryFile: number | undefined;
  try {
    temporaryFile = fs.openSync(temporaryPath, "wx", fs.statSync(filePath).mode);
    fs.writeFileSync(temporaryFile, contents, "utf8");
    fs.fsyncSync(temporaryFile);
    fs.closeSync(temporaryFile);
    temporaryFile = undefined;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (temporaryFile !== undefined) fs.closeSync(temporaryFile);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function syncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directory, "r");
    fs.fsyncSync(handle);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}
