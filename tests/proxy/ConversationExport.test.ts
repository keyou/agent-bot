import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { conversationImportPrompt, exportConversation } from "../../src/proxy/ConversationExport.js";
import type { ConversationTurn } from "../../src/runtime/types.js";

describe("conversation export", () => {
  test("writes ordered prompts and answers without clipping long text", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentbot-conversation-"));
    try {
      const answer = "完整回答".repeat(10_000);
      async function* turns(): AsyncIterable<ConversationTurn> {
        yield { turnId: "first", messages: [{ role: "user", text: "开始" }, { role: "assistant", text: answer }] };
        yield { turnId: "second", messages: [{ role: "user", text: "继续" }, { role: "assistant", text: "结束" }] };
      }
      const result = await exportConversation(directory, turns());
      const content = await readFile(result.filePath, "utf8");
      expect(result.turnCount).toBe(2);
      expect(content).toContain(answer);
      expect(content.indexOf("开始")).toBeLessThan(content.indexOf(answer));
      expect(content.indexOf(answer)).toBeLessThan(content.indexOf("继续"));
      expect(conversationImportPrompt(result.filePath)).toContain(JSON.stringify(result.filePath));
      expect(conversationImportPrompt(result.filePath)).toContain("不要重复执行");
      expect(conversationImportPrompt(result.filePath)).toContain("分段读取");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes empty and incomplete exports", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentbot-conversation-"));
    try {
      await expect(exportConversation(directory, [])).rejects.toThrow("没有可导出");
      async function* failing(): AsyncIterable<ConversationTurn> {
        yield { turnId: "one", messages: [{ role: "user", text: "partial" }] };
        throw new Error("history unavailable");
      }
      await expect(exportConversation(directory, failing())).rejects.toThrow("history unavailable");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
