import { randomBytes } from "node:crypto";

export interface TerminalCommandState {
  status: "unknown" | "idle" | "running";
  command?: string;
  source?: "shell" | "process";
}

export class TerminalCommandTracker {
  readonly nonce = randomBytes(16).toString("hex");
  private readonly prefix = String.fromCharCode(27) + "]777;agentbot;" + this.nonce + ";";
  private pending = "";
  private current: TerminalCommandState = { status: "unknown" };

  snapshot(): TerminalCommandState { return { ...this.current }; }

  consume(data: string): string {
    this.pending += data;
    let output = "";
    while (this.pending) {
      const start = this.pending.indexOf(this.prefix);
      if (start < 0) {
        let retained = Math.min(this.prefix.length - 1, this.pending.length);
        while (retained && !this.prefix.startsWith(this.pending.slice(-retained))) retained--;
        output += this.pending.slice(0, this.pending.length - retained);
        this.pending = this.pending.slice(this.pending.length - retained);
        break;
      }
      output += this.pending.slice(0, start); this.pending = this.pending.slice(start);
      const end = this.pending.indexOf("\u0007", this.prefix.length);
      if (end < 0 && this.pending.length <= 32_768) break;
      if (end < 0 || end > 32_768) {
        output += this.pending[0]; this.pending = this.pending.slice(1); continue;
      }
      const payload = this.pending.slice(this.prefix.length, end);
      if (payload === "idle") this.current = { status: "idle", source: "shell" };
      else if (payload.startsWith("command;") && /^[A-Za-z0-9+/]*={0,2}$/u.test(payload.slice(8))) {
        const command = Buffer.from(payload.slice(8), "base64").toString("utf8")
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim();
        this.current = { status: "running", source: "shell", command: command.slice(0, 2_000) || undefined };
      } else this.current = { status: "unknown" };
      this.pending = this.pending.slice(end + 1);
    }
    return output;
  }
}

export function powerShellTrackingScript(nonce: string): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error("Invalid terminal tracking nonce.");
  // Wrap the accepted line, not the history hook (which skips duplicate commands).
  // Leave editing/history policy intact and call the original prompt/readline before altering $?.
  return [
    "$global:__AgentBotPrompt = $function:prompt",
    "$global:__AgentBotMarker = [char]27 + ']777;agentbot;" + nonce + ";'",
    "try {",
    "  Import-Module PSReadLine -ErrorAction Stop",
    "  $global:__AgentBotReadLine = $function:PSConsoleHostReadLine",
    "  if ($null -eq $global:__AgentBotReadLine) { throw 'PSConsoleHostReadLine unavailable' }",
    "  function global:PSConsoleHostReadLine {",
    "    $line = & $global:__AgentBotReadLine",
    "    if (-not [string]::IsNullOrWhiteSpace($line)) {",
    "      $text = if ($line.Length -gt 2000) { $line.Substring(0, 2000) } else { $line }",
    "      [Console]::Write($global:__AgentBotMarker + 'command;' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) + [char]7)",
    "    }",
    "    return $line",
    "  }",
    "  function global:prompt {",
    "    $text = & $global:__AgentBotPrompt",
    "    [Console]::Write($global:__AgentBotMarker + 'idle' + [char]7)",
    "    return $text",
    "  }",
    "} catch { [Console]::Write($global:__AgentBotMarker + 'unknown' + [char]7) }",
  ].join("\n");
}
