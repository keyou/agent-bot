import { expect, test, vi } from "vitest";
import { sendTerminalAuthorization } from "../../src/terminal/TerminalCards.js";
import type { TerminalCardView } from "../../src/terminal/TerminalServer.js";

const view: TerminalCardView = {
  contextKey: "chat_id:source:thread_id:topic", commandCardMessageId: "original-command-card", shellStarted: false,
  requestId: "request", terminalId: "terminal", approvalToken: "token", code: "123456", cwd: "/workspace",
  expiresAt: 99999, reopenToken: "B8j3N2pS", reopenUrl: "https://preview.example/terminal/B8j3N2pS", recovery: false, state: "pending", connected: false,
};

test.each([false, true])("authorization stays in the original topic (recovery=%s)", async (recovery) => {
  const outbound = { sendInteractiveCard: vi.fn(), replyInteractiveCard: vi.fn(async () => "approval") };
  expect(await sendTerminalAuthorization(outbound, { ...view, recovery })).toBe("approval");
  expect(outbound.replyInteractiveCard).toHaveBeenCalledWith(view.contextKey,
    { messageId: "original-command-card", replyInThread: true }, expect.any(Object));
  expect(JSON.stringify(outbound.replyInteractiveCard.mock.calls[0])).toContain(view.contextKey);
  expect(outbound.sendInteractiveCard).not.toHaveBeenCalled();
});

test.each(["chat_id:group", "open_id:original-user", "chat_id:private-chat"])("authorization stays in its source conversation %s", async (contextKey) => {
  const outbound = { sendInteractiveCard: vi.fn(async () => "approval"), replyInteractiveCard: vi.fn() };
  expect(await sendTerminalAuthorization(outbound, { ...view, contextKey })).toBe("approval");
  expect(outbound.sendInteractiveCard).toHaveBeenCalledWith(contextKey, expect.any(Object));
  expect(outbound.replyInteractiveCard).not.toHaveBeenCalled();
});

test("topic delivery failure never falls back to private chat or group body", async () => {
  const sendInteractiveCard = vi.fn();
  await expect(sendTerminalAuthorization({ sendInteractiveCard }, view)).rejects.toThrow("原话题");
  const replyInteractiveCard = vi.fn(async () => { throw new Error("topic unavailable"); });
  await expect(sendTerminalAuthorization({ sendInteractiveCard, replyInteractiveCard }, view)).rejects.toThrow("topic unavailable");
  expect(sendInteractiveCard).not.toHaveBeenCalled();
});
