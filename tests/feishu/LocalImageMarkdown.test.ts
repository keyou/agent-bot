import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderMarkdownWithLocalImages } from "../../src/feishu/LocalImageMarkdown.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("renderMarkdownWithLocalImages", () => {
  test("replaces local image links with previewable card images in text order", async () => {
    const first = createImage("main.png");
    const second = createImage("secondary.png");
    const upload = vi.fn(async (filePath: string) => `key-${path.basename(filePath)}`);
    const markdown = `前文\n\n[主屏截图](${markdownPath(first)})\n\n中间\n\n![副屏截图](${markdownPath(second)})\n\n后文`;

    const elements = await renderMarkdownWithLocalImages(markdown, upload, vi.fn());

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "img", "markdown", "img", "markdown"]);
    expect(elements[1]).toEqual({
      tag: "img",
      img_key: "key-main.png",
      alt: { tag: "plain_text", content: "主屏截图" },
      title: { tag: "plain_text", content: "主屏截图" },
      mode: "fit_horizontal",
      preview: true,
    });
    expect(elements[3]).toEqual(expect.objectContaining({ img_key: "key-secondary.png", preview: true }));
  });

  test("uploads a repeated path once and leaves remote or missing links unchanged", async () => {
    const image = createImage("same.png");
    const upload = vi.fn(async () => "shared-key");
    const missing = markdownPath(path.join(path.dirname(image), "missing.png"));
    const markdown = `[一](${markdownPath(image)}) [二](${markdownPath(image)}) [网络](https://example.com/a.png) [缺失](${missing})`;

    const elements = await renderMarkdownWithLocalImages(markdown, upload, vi.fn());

    expect(upload).toHaveBeenCalledOnce();
    expect(elements.filter((element) => element.tag === "img")).toHaveLength(2);
    expect(JSON.stringify(elements)).toContain("https://example.com/a.png");
    expect(JSON.stringify(elements)).toContain("missing.png");
  });

  test("keeps the final answer visible when an image upload fails", async () => {
    const image = createImage("failed.png");
    const error = new Error("upload failed");
    const onUploadError = vi.fn();

    const elements = await renderMarkdownWithLocalImages(
      `前文 [失败截图](${markdownPath(image)}) 后文`,
      async () => { throw error; },
      onUploadError,
    );

    expect(JSON.stringify(elements)).toContain("图片上传失败：失败截图");
    expect(JSON.stringify(elements)).toContain("前文");
    expect(JSON.stringify(elements)).toContain("后文");
    expect(onUploadError).toHaveBeenCalledWith(error, path.resolve(image));
  });

  test("removes empty list markers when standalone local image links become card images", async () => {
    const first = createImage("cnki.png");
    const second = createImage("nobel.png");
    const markdown = [
      "产物：",
      "",
      `- [知网截图](${markdownPath(first)})`,
      `- [诺奖截图](${markdownPath(second)})`,
      "",
      "验证完成。",
    ].join("\n");

    const elements = await renderMarkdownWithLocalImages(
      markdown,
      async (filePath) => `key-${path.basename(filePath)}`,
      vi.fn(),
    );

    expect(elements.map((element) => element.tag)).toEqual(["markdown", "img", "img", "markdown"]);
    expect(elements[0]).toEqual({ tag: "markdown", content: "产物：\n\n" });
    expect(elements[1]).toEqual(expect.objectContaining({
      img_key: "key-cnki.png",
      title: { tag: "plain_text", content: "知网截图" },
    }));
    expect(elements[2]).toEqual(expect.objectContaining({
      img_key: "key-nobel.png",
      title: { tag: "plain_text", content: "诺奖截图" },
    }));
    expect(elements[3]).toEqual({ tag: "markdown", content: "\n\n验证完成。" });
    expect(JSON.stringify(elements)).not.toContain('"content":"- "');
  });

  test("keeps list markers when a local image link shares its line with other text", async () => {
    const image = createImage("inline.png");
    const markdown = `- 前文 [截图](${markdownPath(image)}) 后文`;

    const elements = await renderMarkdownWithLocalImages(
      markdown,
      async () => "key-inline",
      vi.fn(),
    );

    expect(elements).toEqual([
      { tag: "markdown", content: "- 前文 " },
      expect.objectContaining({ tag: "img", img_key: "key-inline" }),
      { tag: "markdown", content: " 后文" },
    ]);
  });

  test.each(["backtick-fence", "tilde-fence", "inline", "double-inline", "indented", "escaped"])("preserves %s image examples without uploading files", async (kind) => {
    const image = createImage("example.png");
    const link = `![Example](${markdownPath(image)})`;
    const examples: Record<string, string> = {
      "backtick-fence": `\`\`\`markdown\n${link}\n\`\`\``,
      "tilde-fence": `~~~markdown\n${link}\n~~~`,
      inline: `Example: \`${link}\``,
      "double-inline": `Example: \`\`a \` ${link}\`\``,
      indented: `    ${link}`,
      escaped: `\\${link}`,
    };
    const markdown = examples[kind]!;
    const upload = vi.fn(async () => "img_example");
    expect(await renderMarkdownWithLocalImages(markdown, upload, vi.fn())).toEqual([{ tag: "markdown", content: markdown }]);
    expect(upload).not.toHaveBeenCalled();
  });

  test("keeps existing Feishu image keys while degrading unsupported image targets", async () => {
    const upload = vi.fn(async () => "unused");
    const native = "Native: ![Image](img_v3_existing-key)";
    const elements = await renderMarkdownWithLocalImages(`${native}\n![Web](https://example.com/a.png)\n![Gone](/missing.png)`, upload, vi.fn());
    expect(JSON.stringify(elements)).toContain(native);
    expect(JSON.stringify(elements)).toContain("[Web](https://example.com/a.png)");
    expect(JSON.stringify(elements)).toContain("图片不可用：Gone");
    expect(upload).not.toHaveBeenCalled();
  });

  test("supports parenthesized filenames and angle-wrapped targets with titles", async () => {
    const image = createImage("screenshot (verified).png");
    const upload = vi.fn(async () => "img_verified");
    const elements = await renderMarkdownWithLocalImages(`![Proof](<${markdownPath(image)}> "Screenshot")`, upload, vi.fn());
    expect(elements).toEqual([expect.objectContaining({ tag: "img", img_key: "img_verified" })]);
    expect(upload).toHaveBeenCalledWith(path.resolve(image));
  });
});

function createImage(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bot-image-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, "fake image");
  return filePath;
}

function markdownPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
