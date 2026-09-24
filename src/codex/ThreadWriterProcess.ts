import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

const PROCESS_INSPECTION_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const LOCK_INSPECTION_CONCURRENCY = 4;
const THREAD_WRITER_LOCK_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/iu;

export interface ThreadWriterProcess {
  writerPid: number;
  writerProcessName: string;
  writerStartedAt?: string;
  applicationPid: number;
  applicationProcessName: string;
  applicationStartedAt?: string;
  displayName: string;
  canClose: boolean;
  commandLine?: string;
}

export interface ThreadWriterProcessController {
  inspect(lockPath: string): Promise<ThreadWriterProcess[]>;
  inspectApplicationThreadIds?(lockPath: string, owner: ThreadWriterProcess): Promise<string[]>;
  close(process: ThreadWriterProcess, force: boolean): Promise<void>;
}

export class SystemThreadWriterProcessController implements ThreadWriterProcessController {
  async inspect(lockPath: string): Promise<ThreadWriterProcess[]> {
    try {
      await access(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return process.platform === "win32"
      ? inspectWindowsLockOwners(lockPath)
      : inspectPosixLockOwners(lockPath);
  }

  async inspectApplicationThreadIds(lockPath: string, owner: ThreadWriterProcess): Promise<string[]> {
    if (!owner.applicationStartedAt) return [];
    let entries;
    try {
      entries = await readdir(path.dirname(lockPath), { withFileTypes: true });
    } catch {
      return [];
    }
    const candidates = entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const match = THREAD_WRITER_LOCK_FILE_PATTERN.exec(entry.name);
      return match?.[1] ? [{ threadId: match[1], lockPath: path.join(path.dirname(lockPath), entry.name) }] : [];
    });
    const ownedThreadIds: string[] = [];
    for (let index = 0; index < candidates.length; index += LOCK_INSPECTION_CONCURRENCY) {
      const batch = candidates.slice(index, index + LOCK_INSPECTION_CONCURRENCY);
      const results = await Promise.all(batch.map(async (candidate) => {
        const owners = samePath(candidate.lockPath, lockPath)
          ? [owner]
          : await this.inspect(candidate.lockPath);
        return owners.some((candidateOwner) => sameApplication(candidateOwner, owner))
          ? candidate.threadId
          : undefined;
      }));
      ownedThreadIds.push(...results.filter((threadId): threadId is string => Boolean(threadId)));
    }
    return ownedThreadIds;
  }

  async close(owner: ThreadWriterProcess, force: boolean): Promise<void> {
    const targetPid = owner.applicationPid;
    if (!owner.canClose) throw new Error("The writer process is not recognized as a closable Agent application.");
    if (!owner.applicationStartedAt) throw new Error("The writer process does not have a stable start-time fingerprint.");
    if (!Number.isSafeInteger(targetPid) || targetPid <= 4 || targetPid === process.pid) {
      throw new Error(`Refusing to close unsafe process PID ${targetPid}.`);
    }
    if (process.platform === "win32") {
      await executeWindowsPowerShell(WINDOWS_CLOSE_PROCESS_SCRIPT, {
        AGENT_BOT_CLOSE_PID: String(targetPid),
        AGENT_BOT_CLOSE_STARTED_AT: owner.applicationStartedAt,
        AGENT_BOT_FORCE_CLOSE: force ? "true" : "false",
        AGENT_BOT_WRITER_PID: String(owner.writerPid),
      });
      return;
    }
    const current = await readPosixProcess(targetPid);
    if (!current || current.startedAt !== owner.applicationStartedAt) {
      throw new Error(`Process PID ${targetPid} no longer matches the inspected writer application.`);
    }
    process.kill(targetPid, force ? "SIGKILL" : "SIGTERM");
  }
}

export function threadWriterLockPath(codexHome: string, threadId: string): string | undefined {
  if (!THREAD_WRITER_LOCK_FILE_PATTERN.test(`${threadId}.lock`)) {
    return undefined;
  }
  return path.join(codexHome, "thread-writer-locks", `${threadId}.lock`);
}

export function parseWindowsLockOwners(value: string): ThreadWriterProcess[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const writerPid = positiveInteger(record.writerPid);
    const applicationPid = positiveInteger(record.applicationPid);
    const writerProcessName = stringValue(record.writerProcessName);
    const applicationProcessName = stringValue(record.applicationProcessName);
    if (!writerPid || !applicationPid || !writerProcessName || !applicationProcessName) return [];
    return [{
      writerPid,
      writerProcessName,
      writerStartedAt: stringValue(record.writerStartedAt),
      applicationPid,
      applicationProcessName,
      applicationStartedAt: stringValue(record.applicationStartedAt),
      displayName: stringValue(record.displayName) ?? applicationProcessName,
      canClose: record.canClose === true,
      commandLine: stringValue(record.commandLine),
    }];
  });
}

async function inspectWindowsLockOwners(lockPath: string): Promise<ThreadWriterProcess[]> {
  const output = await executeWindowsPowerShell(WINDOWS_LOCK_OWNER_SCRIPT, {
    AGENT_BOT_THREAD_LOCK_PATH: lockPath,
  });
  return parseWindowsLockOwners(output);
}

async function inspectPosixLockOwners(lockPath: string): Promise<ThreadWriterProcess[]> {
  const pids = await posixLockOwnerPids(lockPath);
  const owners = await Promise.all(pids.map((pid) => inspectPosixProcess(pid)));
  if (owners.some((owner) => !owner)) throw new Error("Cannot identify a reported thread writer; retry the inspection.");
  return owners.filter((owner): owner is ThreadWriterProcess => owner !== undefined);
}

async function posixLockOwnerPids(lockPath: string): Promise<number[]> {
  const lsof = await tryExecuteFile("lsof", ["-t", "--", lockPath]);
  const result = lsof.ok || lsof.noMatches ? lsof : await tryExecuteFile("fuser", [lockPath]);
  if (!result.ok && !result.noMatches) throw new Error("Cannot inspect thread writers: lsof and fuser failed.");
  const raw = result.stdout;
  return [...new Set(raw.match(/\d+/gu)?.map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0) ?? [])];
}

async function inspectPosixProcess(writerPid: number): Promise<ThreadWriterProcess | undefined> {
  const writer = await readPosixProcess(writerPid);
  if (!writer) return undefined;
  let application = writer;
  let cursor = writer;
  for (let depth = 0; depth < 8 && cursor.parentPid > 1; depth += 1) {
    const parent = await readPosixProcess(cursor.parentPid);
    if (!parent) break;
    if (/\/(?:Codex|ChatGPT)\.app\//iu.test(parent.commandLine)) {
      application = parent;
      break;
    }
    cursor = parent;
  }
  const canClose = isRecognizedWriter(writer.name, writer.commandLine);
  return {
    writerPid,
    writerProcessName: writer.name,
    writerStartedAt: writer.startedAt,
    applicationPid: application.pid,
    applicationProcessName: application.name,
    applicationStartedAt: application.startedAt,
    displayName: /\/(?:Codex|ChatGPT)\.app\//iu.test(application.commandLine)
      ? "Codex Desktop"
      : writer.name,
    canClose,
    commandLine: writer.commandLine,
  };
}

interface PosixProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  startedAt?: string;
  commandLine: string;
}

async function readPosixProcess(pid: number): Promise<PosixProcessInfo | undefined> {
  const [parent, name, startedAt, commandLine] = await Promise.all([
    tryExecuteFile("ps", ["-p", String(pid), "-o", "ppid="]),
    tryExecuteFile("ps", ["-p", String(pid), "-o", "comm="]),
    tryExecuteFile("ps", ["-p", String(pid), "-o", "lstart="]),
    tryExecuteFile("ps", ["-p", String(pid), "-o", "command="]),
  ]);
  const parentPid = Number(parent.stdout.trim());
  const processName = name.stdout.trim();
  if (!parent.ok || !processName || !Number.isSafeInteger(parentPid)) return undefined;
  return {
    pid,
    parentPid,
    name: processName,
    startedAt: startedAt.stdout.trim() || undefined,
    commandLine: commandLine.stdout.trim(),
  };
}

function isRecognizedWriter(name: string, commandLine: string): boolean {
  const candidate = `${name} ${commandLine}`;
  return /(?:^|[\\/\s])(?:codex|trae(?:x|cli)?)(?:\.exe|\.js)?(?:\s|$)/iu.test(candidate)
    && /app-server/iu.test(candidate);
}

async function executeWindowsPowerShell(script: string, extraEnv: Record<string, string>): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return executeFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    extraEnv,
  );
}

function executeFile(command: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: { ...process.env, ...extraEnv },
      timeout: PROCESS_INSPECTION_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}

function tryExecuteFile(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; noMatches: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: PROCESS_INSPECTION_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES, windowsHide: true, encoding: "utf8",
    }, (error, stdout, stderr) => resolve({
      ok: !error, stdout,
      noMatches: error?.code === 1 && !error.killed && !stdout.trim() && !stderr.trim(),
    }));
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameApplication(left: ThreadWriterProcess, right: ThreadWriterProcess): boolean {
  return left.applicationPid === right.applicationPid
    && Boolean(left.applicationStartedAt)
    && left.applicationStartedAt === right.applicationStartedAt;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const WINDOWS_CLOSE_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:AGENT_BOT_CLOSE_PID
$writerPid = [int]$env:AGENT_BOT_WRITER_PID
$expectedStartedAt = $env:AGENT_BOT_CLOSE_STARTED_AT
$forceClose = $env:AGENT_BOT_FORCE_CLOSE -eq 'true'
$process = Get-Process -Id $targetPid -ErrorAction Stop
$actualStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
if ($actualStartedAt -ne $expectedStartedAt) {
  throw "Process PID $targetPid no longer matches the inspected writer application."
}
if ($forceClose) {
  & taskkill.exe /PID $targetPid /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "taskkill failed with exit code $LASTEXITCODE" }
} elseif ($targetPid -ne $writerPid -and $process.MainWindowHandle -ne 0) {
  if (-not $process.CloseMainWindow()) {
    throw "The application did not accept a close request."
  }
} else {
  Stop-Process -Id $targetPid -ErrorAction Stop
}
`;

const WINDOWS_LOCK_OWNER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentBotRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  public enum RM_APP_TYPE { UnknownApp=0, MainWindow=1, OtherWindow=2, Service=3, Explorer=4, Console=5, Critical=1000 }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmStartSession(out uint sessionHandle, int sessionFlags, StringBuilder sessionKey);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmRegisterResources(uint sessionHandle, uint fileCount, string[] files, uint applicationCount, RM_UNIQUE_PROCESS[] applications, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint sessionHandle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] processes, ref uint rebootReasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint sessionHandle);
}
'@

function Get-AgentBotProcess([int]$processId) {
  Get-CimInstance Win32_Process -Filter ("ProcessId=" + $processId) -ErrorAction SilentlyContinue
}

function Get-AgentBotStartTime([int]$processId) {
  try { (Get-Process -Id $processId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { $null }
}

$lockPath = $env:AGENT_BOT_THREAD_LOCK_PATH
$key = New-Object Text.StringBuilder 64
[uint32]$handle = 0
$result = [AgentBotRestartManager]::RmStartSession([ref]$handle, 0, $key)
if ($result -ne 0) { throw "RmStartSession failed: $result" }
try {
  $result = [AgentBotRestartManager]::RmRegisterResources($handle, 1, [string[]]@($lockPath), 0, $null, 0, $null)
  if ($result -ne 0) { throw "RmRegisterResources failed: $result" }
  [uint32]$needed = 0
  [uint32]$count = 0
  [uint32]$rebootReasons = 0
  $result = [AgentBotRestartManager]::RmGetList($handle, [ref]$needed, [ref]$count, $null, [ref]$rebootReasons)
  if ($result -eq 0) {
    ConvertTo-Json -Compress -InputObject @()
    return
  }
  if ($result -ne 234) { throw "RmGetList failed: $result" }
  $items = New-Object 'AgentBotRestartManager+RM_PROCESS_INFO[]' $needed
  $count = $needed
  $result = [AgentBotRestartManager]::RmGetList($handle, [ref]$needed, [ref]$count, $items, [ref]$rebootReasons)
  if ($result -ne 0) { throw "RmGetList failed: $result" }
  $owners = @()
  for ($index = 0; $index -lt $count; $index++) {
    $writerPid = $items[$index].Process.dwProcessId
    $writer = Get-AgentBotProcess $writerPid
    if ($null -eq $writer) { throw "Cannot identify reported thread writer PID $writerPid; retry the inspection." }
    $application = $writer
    $cursor = $writer
    for ($depth = 0; $depth -lt 8 -and $cursor.ParentProcessId -gt 1; $depth++) {
      $parent = Get-AgentBotProcess $cursor.ParentProcessId
      if ($null -eq $parent) { break }
      if ($parent.Name -ieq 'ChatGPT.exe' -and $parent.ExecutablePath -match 'OpenAI[.\\]Codex') {
        $application = $parent
        break
      }
      $cursor = $parent
    }
    $recognized = (($writer.Name -match '^(codex|trae|traex|traecli)(.exe)?$') -or ($writer.CommandLine -match '(codex|trae|traex|traecli).*(app-server)'))
    $desktop = $application.Name -ieq 'ChatGPT.exe' -and $application.ExecutablePath -match 'OpenAI[.\\]Codex'
    $owners += [pscustomobject]@{
      writerPid = $writerPid
      writerProcessName = $writer.Name
      writerStartedAt = Get-AgentBotStartTime $writerPid
      applicationPid = [int]$application.ProcessId
      applicationProcessName = $application.Name
      applicationStartedAt = Get-AgentBotStartTime $application.ProcessId
      displayName = $(if ($desktop) { 'Codex Desktop' } else { $writer.Name })
      canClose = [bool]$recognized
      commandLine = $writer.CommandLine
    }
  }
  ConvertTo-Json -Compress -InputObject @($owners)
} finally {
  [void][AgentBotRestartManager]::RmEndSession($handle)
}
`;
