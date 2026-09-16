import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { FeishuApiError, FeishuMessageClient } from "../../src/feishu/FeishuMessageClient.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FeishuMessageClient", () => {
  test("creates a private Feishu group and invites the current user", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { chat_id: "oc_new_group" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.createGroup({
      name: "[codex] 广州天气",
      userOpenId: "ou_current_user",
    })).resolves.toEqual({
      chatId: "oc_new_group",
      name: "[codex] 广州天气",
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      chat_mode: "group",
      chat_type: "private",
      name: "[codex] 广州天气",
      user_id_list: ["ou_current_user"],
    });
  });

  test("dissolves a Feishu group by chat ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: {} }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.deleteGroup("oc_group/id")).resolves.toBeUndefined();

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/chats/oc_group%2Fid",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
  });

  test("uploads and assigns an avatar while creating a Feishu group", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_avatar" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { chat_id: "oc_avatar_group" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.createGroup({
      name: "Avatar group",
      userOpenId: "ou_current_user",
      avatarPng: new Uint8Array([137, 80, 78, 71]),
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://open.feishu.cn/open-apis/im/v1/images");
    const form = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("image_type")).toBe("avatar");
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      chat_mode: "group",
      chat_type: "private",
      name: "Avatar group",
      user_id_list: ["ou_current_user"],
      avatar: "img_avatar",
    });
  });

  test("downloads a Feishu message image into the bot data directory and caches it", async () => {
    const clientConfig = config();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(clientConfig, logger());

    const first = await client.downloadImage("om_input", "img_input");
    const second = await client.downloadImage("om_input", "img_input");

    expect(first).toBe(second);
    expect(path.dirname(first)).toBe(path.join(path.dirname(clientConfig.storage.sqlitePath), "inbound-images"));
    expect(path.extname(first)).toBe(".png");
    expect([...fs.readFileSync(first)]).toEqual([1, 2, 3, 4]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_input/resources/img_input?type=image",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("downloads a Feishu message file into the bot data directory with a safe name and caches it", async () => {
    const clientConfig = config();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([5, 6, 7, 8]), { status: 200 }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(clientConfig, logger());

    const first = await client.downloadFile("om_file_input", "file_input", "../report?.pdf");
    const second = await client.downloadFile("om_file_input", "file_input", "ignored.pdf");

    expect(first).toBe(second);
    expect(path.dirname(first)).toBe(path.join(path.dirname(clientConfig.storage.sqlitePath), "inbound-files"));
    expect(path.basename(first)).toMatch(/^[a-f0-9]{16}-report_\.pdf$/u);
    expect([...fs.readFileSync(first)]).toEqual([5, 6, 7, 8]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_file_input/resources/file_input?type=file",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("reads and renders the child messages of a merged-forward message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 0,
        msg: "ok",
        data: {
          items: [
            { message_id: "om_merged", msg_type: "merge_forward" },
            {
              message_id: "om_child",
              upper_message_id: "om_merged",
              msg_type: "text",
              sender: { id: "ou_member", sender_type: "user" },
              body: { content: JSON.stringify({ text: "merged child text" }) },
            },
            {
              message_id: "om_image_child",
              upper_message_id: "om_merged",
              msg_type: "image",
              sender: { id: "ou_member", sender_type: "user" },
              body: { content: JSON.stringify({ image_key: "img_child" }) },
            },
            {
              message_id: "om_file_child",
              upper_message_id: "om_merged",
              msg_type: "file",
              sender: { id: "ou_member", sender_type: "user" },
              body: { content: JSON.stringify({ file_key: "file_child", file_name: "notes.txt" }) },
            },
          ],
        },
      }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.readMergedForward("om_merged")).resolves.toMatchObject({
      messageCount: 3,
      truncated: false,
      text: expect.stringContaining("merged child text"),
      images: [{ messageId: "om_image_child", imageKey: "img_child" }],
      files: [{ messageId: "om_file_child", fileKey: "file_child", fileName: "notes.txt" }],
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_merged",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer token" },
    });
  });

  test("reads and renders a referenced Feishu message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 0,
        msg: "ok",
        data: {
          items: [{
            message_id: "om_quoted_image",
            msg_type: "image",
            body: { content: JSON.stringify({ image_key: "img_quoted" }) },
          }],
        },
      }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.readReferencedMessage("om_quoted_image")).resolves.toEqual({
      text: "[消息类型：图片]\n[图片 1]",
      messageType: "image",
      images: [{ messageId: "om_quoted_image", imageKey: "img_quoted" }],
      files: [],
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_quoted_image",
    );
  });

  test("uploads a local file and sends it as a Feishu file message", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-send-file-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "report.txt");
    fs.writeFileSync(filePath, "report contents");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { file_key: "file_report" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_file" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.sendFile("chat_id:c1", filePath)).resolves.toBe("om_file");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://open.feishu.cn/open-apis/im/v1/files");
    const form = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("file_type")).toBe("stream");
    expect(form.get("file_name")).toBe("report.txt");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      receive_id: "c1",
      msg_type: "file",
      content: JSON.stringify({ file_key: "file_report" }),
    });
  });

  test("uploads a selected file and replies inside the originating topic", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-reply-file-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "topic.txt");
    fs.writeFileSync(filePath, "topic contents");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { file_key: "file_topic" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_topic_file" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.replyFile(
      "chat_id:c1:thread_id:omt_topic",
      { messageId: "om_browser_card", replyInThread: true },
      filePath,
    )).resolves.toBe("om_topic_file");

    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/messages/om_browser_card/reply");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      msg_type: "file",
      content: JSON.stringify({ file_key: "file_topic" }),
      reply_in_thread: true,
    });
  });

  test("adds an OnIt reaction to acknowledge an incoming message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { reaction_id: "reaction_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.addReaction("om_received", "OnIt")).resolves.toBe("reaction_1");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_received/reactions",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      reaction_type: { emoji_type: "OnIt" },
    });
  });

  test("deletes the previous reaction when replacing a message status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.deleteReaction("om_received", "reaction_1");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_received/reactions/reaction_1",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    });
  });

  test("passes a stable UUID with an idempotent final message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    await client.sendMarkdown("chat_id:c1", "answer", "stable-uuid");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.uuid).toBe("stable-uuid");
    expect(JSON.parse(String(body.content))).toMatchObject({
      schema: "2.0",
      body: {
        elements: [{ tag: "markdown", content: "answer" }],
      },
    });
  });

  test("renders final-answer branding after a divider in notation-sized text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown(
      "chat_id:c1",
      "answer\n\n----\n\n> Powered by [AgentBot](https://keyou.github.io/agent-bot/)",
    );

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.msg_type).toBe("interactive");
    expect(JSON.parse(String(body.content))).toMatchObject({
      body: {
        elements: [
          { tag: "markdown", content: "answer" },
          { tag: "hr" },
          {
            tag: "markdown",
            content:
              "> Powered by [AgentBot](https://keyou.github.io/agent-bot/)",
            text_size: "notation",
          },
        ],
      },
    });
  });

  test("keeps a branded plain-text message as plain text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const text = "answer\n\n----\n\nPowered by AgentBot";

    await client.sendText("chat_id:c1", text);

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.msg_type).toBe("text");
    expect(JSON.parse(String(body.content))).toEqual({ text });
  });

  test("retries a rejected final message with audit-safe email text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 230028,
        msg: "The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS",
      }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_safe" } }));
    globalThis.fetch = fetchMock;
    const testLogger = logger();
    const client = new FeishuMessageClient(config(), testLogger);

    await expect(client.sendMarkdown(
      "chat_id:c1",
      "Remote: git@github.com:keyou/agent-bot.git",
      "audit-safe-uuid",
    )).resolves.toBe("om_safe");

    const rejected = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { content: string; uuid: string };
    const retried = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string; uuid: string };
    expect(rejected.content).toContain("git@github.com:keyou/agent-bot.git");
    expect(retried.content).toContain("git [at] github.com:keyou/agent-bot.git");
    expect(retried.content).not.toContain("git@github.com");
    expect(retried.uuid).toBe(rejected.uuid);
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 230028 }),
      expect.stringContaining("audit-safe text"),
    );
  });

  test("retries a rejected thread reply with audit-safe email text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 230028,
        msg: "The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS",
      }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_reply_safe" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.replyMarkdown(
      "chat_id:c1",
      { messageId: "om_source", replyInThread: true },
      "Contact user@example.com",
      "reply-audit-safe-uuid",
    )).resolves.toBe("om_reply_safe");

    const retried = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string; uuid: string };
    expect(retried.content).toContain("user [at] example.com");
    expect(retried.content).not.toContain("user@example.com");
    expect(retried.uuid).toBe("reply-audit-safe-uuid");
  });

  test("falls back to text when a final card exceeds the Feishu table limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 230099,
        msg: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table;",
      }, 400))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_text" } }));
    globalThis.fetch = fetchMock;
    const testLogger = logger();
    const client = new FeishuMessageClient(config(), testLogger);
    const markdown = "| A | B |\n| --- | --- |\n| 1 | 2 |";

    await expect(client.sendMarkdown("chat_id:c1", markdown, "table-fallback-uuid"))
      .resolves.toBe("om_text");

    const rejected = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const fallback = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(rejected.msg_type).toBe("interactive");
    expect(fallback).toMatchObject({ msg_type: "text", uuid: "table-fallback-uuid" });
    expect(JSON.parse(String(fallback.content))).toEqual({ text: markdown });
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 230099, contextKey: "chat_id:c1" }),
      expect.stringContaining("retrying as text"),
    );
  });

  test("falls back to a text reply when a thread card exceeds the Feishu table limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 230099,
        msg: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table;",
      }, 400))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_reply_text" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const target = { messageId: "om_source", replyInThread: true as const };
    const markdown = "| A | B |\n| --- | --- |\n| 1 | 2 |";

    await expect(client.replyMarkdown(
      "chat_id:c1",
      target,
      markdown,
      "reply-table-fallback-uuid",
    )).resolves.toBe("om_reply_text");

    const fallback = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(fallback).toMatchObject({
      msg_type: "text",
      reply_in_thread: true,
      uuid: "reply-table-fallback-uuid",
    });
    expect(JSON.parse(String(fallback.content))).toEqual({ text: markdown });
  });

  test("retries a rejected card update with audit-safe email text", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 230028,
        msg: "The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS",
      }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.updateInteractiveCard("om_progress", {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "Remote: git@github.com:keyou/project.git" }] },
    })).resolves.toBeUndefined();

    const retried = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    expect(retried.content).toContain("git [at] github.com:keyou/project.git");
    expect(retried.content).not.toContain("git@github.com");
  });

  test("serializes updates to the same interactive card", async () => {
    let finishFirstUpdate!: (value: ReturnType<typeof response>) => void;
    const firstUpdate = new Promise<ReturnType<typeof response>>((resolve) => {
      finishFirstUpdate = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockImplementationOnce(() => firstUpdate)
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    const first = client.updateInteractiveCard("om_progress", { sequence: 1 });
    const second = client.updateInteractiveCard("om_progress", { sequence: 2 });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      content: JSON.stringify({ sequence: 1 }),
    });

    finishFirstUpdate(response({ code: 0, msg: "ok" }));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      content: JSON.stringify({ sequence: 2 }),
    });
  });

  test("uses the base chat id when sending for a thread-scoped task context", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_1" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendText("chat_id:oc_private:thread_id:omt_topic", "fallback");

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body.receive_id).toBe("oc_private");
  });

  test("replies with an interactive card inside the source message thread", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_progress" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await expect(client.replyInteractiveCard(
      "chat_id:oc_group",
      { messageId: "om_question", replyInThread: true },
      { schema: "2.0", body: { elements: [] } },
      "stable-progress-uuid",
    )).resolves.toBe("om_progress");

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_question/reply",
    );
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      msg_type: "interactive",
      reply_in_thread: true,
      uuid: "stable-progress-uuid",
    });
    expect(JSON.parse(String(body.content))).toEqual({ schema: "2.0", body: { elements: [] } });
  });

  test("uses a Card 2.0 markdown component for final answers in message threads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_final" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const markdown = "调用 `/fork <任务 ID>`，并检查 `aria_role`。";

    await client.replyMarkdown(
      "chat_id:oc_group",
      { messageId: "om_question", replyInThread: true },
      markdown,
      "stable-final-uuid",
    );

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(body.content)) as {
      schema: string;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card).toEqual({
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      body: { elements: [{ tag: "markdown", content: markdown }] },
    });
  });

  test("makes fenced code blocks nested under list items visible in Feishu cards", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_final" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const markdown = [
      "1. Actor 错误全部转为：",
      "",
      "   ```cpp",
      "   BuaRendererActionError::kActionFailed",
      "   ```",
    ].join("\n");

    await client.sendMarkdown("chat_id:c1", markdown);

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(body.content)) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.body.elements).toEqual([{
      tag: "markdown",
      content: [
        "1. Actor 错误全部转为：",
        "",
        "```cpp",
        "BuaRendererActionError::kActionFailed",
        "```",
      ].join("\n"),
    }]);
  });

  test("classifies network failures during card update as retryable", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockRejectedValueOnce(new Error("socket reset"));
    const client = new FeishuMessageClient(config(), logger());
    const error = await client.updateInteractiveCard("om_1", {}).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(FeishuApiError);
    expect((error as FeishuApiError).isRetryable).toBe(true);
  });

  test("uploads local screenshots and sends previewable image elements with the stable UUID", async () => {
    const imagePath = createImage("screen.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_screen" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_image" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown("chat_id:c1", `前文\n[屏幕截图](${markdownPath(imagePath)})\n后文`, "image-uuid");

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/open-apis/im/v1/images");
    const uploadBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(uploadBody).toBeInstanceOf(FormData);
    expect((uploadBody as FormData).get("image_type")).toBe("message");
    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(messageBody.content)) as { body: { elements: Array<Record<string, unknown>> } };
    expect(messageBody.uuid).toBe("image-uuid");
    expect(card.body.elements.map((element) => element.tag)).toEqual(["markdown", "img", "markdown"]);
    expect(card.body.elements[1]).toEqual(expect.objectContaining({ img_key: "img_screen", preview: true }));
  });

  test("uploads angle-wrapped slash-prefixed Windows screenshot paths from restored Codex answers", async () => {
    const imagePath = createImage("restored.png");
    const slashPrefixedPath = `/${markdownPath(imagePath)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_restored" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_restored" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown(
      "chat_id:c1",
      `截图：\n\n![恢复截图](<${slashPrefixedPath}>)`,
      "restored-image-uuid",
    );

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/open-apis/im/v1/images");
    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    const card = JSON.parse(String(messageBody.content)) as { body: { elements: Array<Record<string, unknown>> } };
    expect(card.body.elements.at(-1)).toEqual(expect.objectContaining({ tag: "img", img_key: "img_restored" }));
    expect(messageBody.uuid).toBe("restored-image-uuid");
  });

  test("removes unsupported image syntax before sending a Feishu card", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_fallback" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());

    await client.sendMarkdown(
      "chat_id:c1",
      "截图：![已删除](</D:/missing/screenshot.png>)，远程图：![查看](https://example.com/image.png)",
    );

    const messageBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    const content = String(messageBody.content);
    expect(content).toContain("图片不可用：已删除");
    expect(content).toContain("[查看](https://example.com/image.png)");
    expect(content).not.toContain("![");
    expect(content).not.toContain('"tag":"img"');
  });

  test("sends private update cards with a durable idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_update" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    await expect(client.sendInteractiveCard("open_id:ou_owner", { schema: "2.0", body: { elements: [] } }, "update-uuid"))
      .resolves.toBe("om_update");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ receive_id: "ou_owner", uuid: "update-uuid", msg_type: "interactive" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("receive_id_type=open_id");
  });

  test("uploads view_image previews in cards once and reuses the image key on updates", async () => {
    const imagePath = createImage("view.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_view" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_view" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const card = {
      schema: "2.0",
      body: {
        elements: [{
          tag: "collapsible_panel",
          expanded: false,
          elements: [{
            tag: "img",
            img_key: "",
            __acp_local_image_path: imagePath,
            alt: { tag: "plain_text", content: "view_image 图片" },
            preview: true,
          }],
        }],
      },
    };

    await client.sendInteractiveCard("chat_id:c1", card);
    await client.updateInteractiveCard("om_view", card);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/im/v1/images"))).toHaveLength(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    const updated = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as { content: string };
    for (const content of [sent.content, updated.content]) {
      expect(content).toContain('"img_key":"img_view"');
      expect(content).not.toContain("__acp_local_image_path");
    }
  });

  test("uploads a replacement image when the same file path has a newer modification time", async () => {
    const imagePath = createImage("replaced-view.png");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_old" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_replaced_view" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { image_key: "img_new" } }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok" }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), logger());
    const card = {
      schema: "2.0",
      body: {
        elements: [{
          tag: "img",
          img_key: "",
          __acp_local_image_path: imagePath,
          alt: { tag: "plain_text", content: "view_image 图片" },
          preview: true,
        }],
      },
    };

    await client.sendInteractiveCard("chat_id:c1", card);
    fs.writeFileSync(imagePath, "replacement image");
    const newer = new Date(Date.now() + 2_000);
    fs.utimesSync(imagePath, newer, newer);
    await client.updateInteractiveCard("om_replaced_view", card);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/im/v1/images"))).toHaveLength(2);
    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    const updated = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as { content: string };
    expect(sent.content).toContain('"img_key":"img_old"');
    expect(updated.content).toContain('"img_key":"img_new"');
  });

  test("keeps the tool card usable when a view_image preview cannot be uploaded", async () => {
    const imagePath = createImage("unavailable.png");
    const testLogger = logger();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 234001, msg: "bad image" }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_fallback" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), testLogger);

    await client.sendInteractiveCard("chat_id:c1", {
      schema: "2.0",
      body: {
        elements: [{
          tag: "collapsible_panel",
          elements: [{
            tag: "img",
            img_key: "",
            __acp_local_image_path: imagePath,
            alt: { tag: "plain_text", content: "view_image 图片" },
          }],
        }],
      },
    });

    const sent = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { content: string };
    expect(sent.content).toContain("图片加载失败：view_image 图片");
    expect(sent.content).not.toContain("__acp_local_image_path");
    expect(testLogger.warn).toHaveBeenCalled();
  });

  test("sends the remaining answer with a visible notice when image upload fails", async () => {
    const imagePath = createImage("failed.png");
    const testLogger = logger();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", tenant_access_token: "token", expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 234001, msg: "bad image" }))
      .mockResolvedValueOnce(response({ code: 0, msg: "ok", data: { message_id: "om_fallback" } }));
    globalThis.fetch = fetchMock;
    const client = new FeishuMessageClient(config(), testLogger);

    await client.sendMarkdown("chat_id:c1", `答案 [失败截图](${markdownPath(imagePath)}) 继续`, "fallback-uuid");

    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(String(messageBody.content)).toContain("图片上传失败：失败截图");
    expect(String(messageBody.content)).toContain("答案");
    expect(String(messageBody.content)).toContain("继续");
    expect(testLogger.warn).toHaveBeenCalled();
  });
});

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    json: async () => payload,
  };
}

function config(): AppConfig {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-client-data-"));
  temporaryDirectories.push(directory);
  return {
    feishu: { appId: "cli_app", appSecret: "secret" },
    storage: { sqlitePath: path.join(directory, "state.sqlite") },
  } as unknown as AppConfig;
}

function logger(): Logger {
  return { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function createImage(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-client-image-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, "fake image");
  return filePath;
}

function markdownPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
