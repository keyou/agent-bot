import { describe, expect, test } from "vitest";
import {
  renderMergedForwardPrompt,
  renderReferencedMessage,
} from "../../src/feishu/MergedForwardMessage.js";

describe("merged-forward message rendering", () => {
  test("preserves child order, stable sender labels, mentions, and media placeholders", () => {
    const result = renderMergedForwardPrompt("om_parent", [
      {
        message_id: "om_parent",
        msg_type: "merge_forward",
        body: { content: JSON.stringify({ content: "Merged and Forwarded Message" }) },
      },
      {
        message_id: "om_1",
        upper_message_id: "om_parent",
        msg_type: "text",
        create_time: "1786586400000",
        sender: { id: "ou_alice", sender_type: "user" },
        body: { content: JSON.stringify({ text: "@_user_1 请看第一条" }) },
        mentions: [{ key: "@_user_1", id: "ou_bob", name: "Bob" }],
      },
      {
        message_id: "om_2",
        upper_message_id: "om_parent",
        msg_type: "post",
        sender: { id: "ou_bob", sender_type: "user" },
        body: {
          content: JSON.stringify({
            zh_cn: {
              title: "<p>富文本标题</p>",
              content: [
                [{ tag: "text", text: "第二条" }, { tag: "img", image_key: "img_1" }],
                [{ tag: "img", image_key: "img_1" }],
              ],
            },
          }),
        },
      },
      {
        message_id: "om_3",
        upper_message_id: "om_parent",
        msg_type: "image",
        sender: { id: "ou_alice", sender_type: "user" },
        body: { content: JSON.stringify({ image_key: "img_2" }) },
      },
      {
        message_id: "om_4",
        upper_message_id: "om_parent",
        msg_type: "file",
        sender: { id: "ou_alice", sender_type: "user" },
        body: { content: JSON.stringify({ file_key: "file_report", file_name: "report.pdf" }) },
      },
    ]);

    expect(result).toMatchObject({
      messageCount: 4,
      truncated: false,
      images: [
        { messageId: "om_2", imageKey: "img_1" },
        { messageId: "om_3", imageKey: "img_2" },
      ],
      files: [{ messageId: "om_4", fileKey: "file_report", fileName: "report.pdf" }],
    });
    expect(result.text).toContain("一组聊天记录（共 4 条）");
    expect(result.text).toContain("[消息 1 · 成员 1 · 2026-08-13 02:00:00 UTC]");
    expect(result.text).toContain("@Bob 请看第一条");
    expect(result.text).toContain("[消息 2 · 成员 2]");
    expect(result.text).toContain("富文本标题\n第二条[图片 1]\n[图片 1]");
    expect(result.text).toContain("[消息 3 · 成员 1]\n[图片 2]");
    expect(result.text).toContain("[消息 4 · 成员 1]");
    expect(result.text).toContain("[文件 1：report.pdf]");
  });

  test("truncates oversized transcripts in the middle while retaining both ends", () => {
    const result = renderMergedForwardPrompt("om_parent", [
      {
        upper_message_id: "om_parent",
        msg_type: "text",
        sender: { id: "ou_1", sender_type: "user" },
        body: { content: JSON.stringify({ text: `开头${"甲".repeat(300)}` }) },
      },
      {
        upper_message_id: "om_parent",
        msg_type: "text",
        sender: { id: "ou_2", sender_type: "user" },
        body: { content: JSON.stringify({ text: `${"乙".repeat(300)}结尾` }) },
      },
    ], 240);

    expect(Array.from(result.text)).toHaveLength(240);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("开头");
    expect(result.text).toContain("中间部分已截断");
    expect(result.text).toContain("结尾");
  });

  test("rejects a merged-forward response without child messages", () => {
    expect(() => renderMergedForwardPrompt("om_parent", [{
      message_id: "om_parent",
      msg_type: "merge_forward",
    }])).toThrow("没有可读取的子消息");
  });

  test("renders a referenced image with a stable Prompt label and resource", () => {
    expect(renderReferencedMessage("om_image", [{
      message_id: "om_image",
      msg_type: "image",
      body: { content: JSON.stringify({ image_key: "img_1" }) },
    }])).toEqual({
      text: "[消息类型：图片]\n[图片 1]",
      messageType: "image",
      images: [{ messageId: "om_image", imageKey: "img_1" }],
      files: [],
    });
  });

  test("renders text, rich text images, files, and visible card content", () => {
    expect(renderReferencedMessage("om_text", [{
      message_id: "om_text",
      msg_type: "text",
      body: { content: JSON.stringify({ text: "引用正文" }) },
    }]).text).toBe("[消息类型：文本]\n引用正文");

    expect(renderReferencedMessage("om_post", [{
      message_id: "om_post",
      msg_type: "post",
      body: { content: JSON.stringify({ zh_cn: { content: [[
        { tag: "text", text: "截图：" },
        { tag: "img", image_key: "img_post" },
        { tag: "a", text: "Pull request", href: "https://github.com/example/project/pull/1" },
      ], [
        { tag: "code_block", language: "TYPESCRIPT", text: "const answer = 42;" },
      ]] } }) },
    }])).toMatchObject({
      text: "[消息类型：富文本]\n截图：[图片 1]Pull request (https://github.com/example/project/pull/1)\n```typescript\nconst answer = 42;\n```",
      images: [{ messageId: "om_post", imageKey: "img_post" }],
    });

    expect(renderReferencedMessage("om_file", [{
      message_id: "om_file",
      msg_type: "file",
      body: { content: JSON.stringify({ file_key: "file_1", file_name: "notes.txt" }) },
    }])).toMatchObject({
      text: "[消息类型：文件]\n[文件 1：notes.txt]",
      files: [{ messageId: "om_file", fileKey: "file_1", fileName: "notes.txt" }],
    });

    expect(renderReferencedMessage("om_card", [{
      message_id: "om_card",
      msg_type: "interactive",
      body: { content: JSON.stringify({ header: { title: { content: "卡片标题" } }, elements: [
        { tag: "markdown", content: "卡片正文" },
      ] }) },
    }]).text).toBe("[消息类型：卡片]\n卡片标题\n卡片正文");
  });
});
