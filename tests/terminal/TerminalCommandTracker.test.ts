import { expect, test } from "vitest";
import { powerShellTrackingScript, TerminalCommandTracker } from "../../src/terminal/TerminalCommandTracker.js";

test("tracks actual shell commands and idle markers across arbitrary PTY chunk boundaries", () => {
  const tracker = new TerminalCommandTracker();
  const marker = (text: string) => '\u001b]777;agentbot;' + tracker.nonce + ';' + text + '\u0007';
  expect(tracker.snapshot()).toEqual({ status: "unknown" });
  const command = "Write-Output '中文'; Start-Sleep -Seconds 10";
  const encoded = marker('command;' + Buffer.from(command).toString('base64'));
  let visible = '';
  for (const char of 'prompt' + encoded + 'output') visible += tracker.consume(char);
  expect(visible).toBe('promptoutput');
  expect(tracker.snapshot()).toEqual({ status: 'running', source: 'shell', command });
  expect(tracker.consume(marker('idle') + 'PS> ')).toBe('PS> ');
  expect(tracker.snapshot()).toEqual({ status: 'idle', source: 'shell' });
});

test("does not treat ordinary output, input echo, or an unrelated OSC title as a command", () => {
  const tracker = new TerminalCommandTracker();
  const output = '\u001b[31merror\u001b[0m\r\nPS> echo hello\r\n\u001b]0;my title\u0007';
  expect(tracker.consume(output)).toBe(output);
  expect(tracker.snapshot()).toEqual({ status: 'unknown' });
  expect(tracker.consume('\u001b]777;agentbot;' + 'a'.repeat(32) + ';idle\u0007')).toContain(';idle');
  expect(tracker.snapshot()).toEqual({ status: 'unknown' });
});

test("bounds unfinished markers and command text, clearing stale commands on unknown state", () => {
  const tracker = new TerminalCommandTracker();
  const prefix = '\u001b]777;agentbot;' + tracker.nonce + ';';
  const command = 'x'.repeat(3000);
  expect(tracker.consume(prefix + 'command;' + Buffer.from(command).toString('base64') + '\u0007')).toBe('');
  expect(tracker.snapshot().command).toHaveLength(2000);
  expect(tracker.consume(prefix + 'unknown\u0007')).toBe('');
  expect(tracker.snapshot()).toEqual({ status: 'unknown' });
  const output = prefix + 'x'.repeat(40_000);
  expect(tracker.consume(output)).toBe(output);
});

test("PowerShell integration wraps accepted lines without changing key or history policies", () => {
  const script = powerShellTrackingScript('a'.repeat(32));
  expect(script).toContain('$global:__AgentBotReadLine = $function:PSConsoleHostReadLine');
  expect(script).toContain('$line = & $global:__AgentBotReadLine');
  expect(script).toContain('return $line');
  expect(script).toContain('$global:__AgentBotPrompt = $function:prompt');
  expect(script).toContain('& $global:__AgentBotPrompt');
  expect(script).not.toContain('Set-PSReadLineKeyHandler');
  expect(script).not.toContain('Set-PSReadLineOption');
  expect(() => powerShellTrackingScript("'; injected")).toThrow('nonce');
});
