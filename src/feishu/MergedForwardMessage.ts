import { normalizeFeishuPostText, renderFeishuCodeBlock } from "./InboundText.js";

export const MAX_MERGED_FORWARD_PROMPT_CHARS = 48_000;

export interface MergedForwardMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  sender?: {
    id?: string;
    sender_type?: string;
  };
  body?: {
    content?: string;
  };
  mentions?: Array<{
    key?: string;
    id?: string;
    name?: string;
  }>;
  upper_message_id?: string;
}

export interface MergedForwardContent {
  text: string;
  messageCount: number;
  truncated: boolean;
  images: MergedForwardImageReference[];
  files: MergedForwardFileReference[];
}

export interface MergedForwardImageReference {
  messageId: string;
  imageKey: string;
}

export interface MergedForwardFileReference {
  messageId: string;
  fileKey: string;
  fileName: string;
}

export interface ReferencedMessageContent {
  text: string;
  messageType: string;
  images: MergedForwardImageReference[];
  files: MergedForwardFileReference[];
}

export function renderReferencedMessage(
  messageId: string,
  items: MergedForwardMessageItem[],
): ReferencedMessageContent {
  const item = items.find((candidate) => candidate.message_id === messageId)
    ?? items.find((candidate) => !candidate.upper_message_id)
    ?? items[0];
  if (!item) throw new Error("引用消息不存在或已无法访问。");

  if (item.msg_type === "merge_forward") {
    const merged = renderMergedForwardPrompt(messageId, items);
    return {
      text: `[消息类型：合并转发]\n${merged.text}`,
      messageType: "merge_forward",
      images: merged.images,
      files: merged.files,
    };
  }

  const images: MergedForwardImageReference[] = [];
  const files: MergedForwardFileReference[] = [];
  const imageNumbers = new Map<string, number>();
  const content = renderMessageContent(item, (imageKey) => {
    if (!imageKey) return "[图片]";
    let imageNumber = imageNumbers.get(imageKey);
    if (!imageNumber) {
      imageNumber = images.length + 1;
      imageNumbers.set(imageKey, imageNumber);
      images.push({ messageId, imageKey });
    }
    return `[图片 ${imageNumber}]`;
  }, (fileKey, fileName) => {
    if (!fileKey) return namedPlaceholder("文件", fileName);
    const fileNumber = files.length + 1;
    const resolvedName = fileName || `file-${fileNumber}`;
    files.push({ messageId, fileKey, fileName: resolvedName });
    return `[文件 ${fileNumber}：${resolvedName}]`;
  });
  const messageType = item.msg_type?.trim() || "unknown";
  return {
    text: `[消息类型：${messageTypeLabel(messageType)}]\n${content}`,
    messageType,
    images,
    files,
  };
}

export function renderMergedForwardPrompt(
  parentMessageId: string,
  items: MergedForwardMessageItem[],
  maxChars = MAX_MERGED_FORWARD_PROMPT_CHARS,
): MergedForwardContent {
  const children = items.filter((item) => item.upper_message_id === parentMessageId);
  if (children.length === 0) throw new Error("合并转发消息中没有可读取的子消息。");

  const senderLabels = new Map<string, string>();
  const imageNumbers = new Map<string, number>();
  const images: MergedForwardImageReference[] = [];
  const files: MergedForwardFileReference[] = [];
  let userIndex = 0;
  let appIndex = 0;
  const blocks = children.map((item, index) => {
    const sender = item.sender?.id?.trim();
    let senderLabel = "未知发送者";
    if (sender) {
      const senderType = item.sender?.sender_type === "app" ? "app" : "user";
      const senderKey = `${senderType}:${sender}`;
      const existing = senderLabels.get(senderKey);
      if (existing) {
        senderLabel = existing;
      } else {
        senderLabel = senderType === "app" ? `应用 ${++appIndex}` : `成员 ${++userIndex}`;
        senderLabels.set(senderKey, senderLabel);
      }
    }
    const time = formatMessageTime(item.create_time);
    const heading = [`消息 ${index + 1}`, senderLabel, time].filter(Boolean).join(" · ");
    return `[${heading}]\n${renderMessageContent(item, (imageKey) => {
      const messageId = item.message_id?.trim();
      if (!messageId || !imageKey) return "[图片]";
      const referenceKey = `${messageId}:${imageKey}`;
      let imageNumber = imageNumbers.get(referenceKey);
      if (!imageNumber) {
        imageNumber = images.length + 1;
        imageNumbers.set(referenceKey, imageNumber);
        images.push({ messageId, imageKey });
      }
      return `[图片 ${imageNumber}]`;
    }, (fileKey, fileName) => {
      const messageId = item.message_id?.trim();
      if (!messageId || !fileKey) return namedPlaceholder("文件", fileName);
      const fileNumber = files.length + 1;
      files.push({ messageId, fileKey, fileName: fileName || `file-${fileNumber}` });
      return `[文件 ${fileNumber}：${fileName || `file-${fileNumber}`}]`;
    })}`;
  });
  const prompt = [
    `用户转发了一组聊天记录（共 ${children.length} 条）。以下内容是引用的聊天记录，请结合这些内容回应用户。`,
    ...blocks,
  ].join("\n\n");
  const truncated = truncateMiddle(prompt, maxChars);
  return {
    text: truncated.text,
    messageCount: children.length,
    truncated: truncated.truncated,
    images,
    files,
  };
}

function renderMessageContent(
  item: MergedForwardMessageItem,
  imageLabel: (imageKey: string) => string,
  fileLabel: (fileKey: string, fileName: string) => string,
): string {
  if (item.deleted) return "[消息已撤回]";
  const messageType = item.msg_type?.trim() || "unknown";
  const content = parseJsonObject(item.body?.content);
  switch (messageType) {
    case "text":
      return replaceMentions(textValue(content.text), item.mentions) || "[空文本消息]";
    case "post":
      return renderPost(content, item.mentions, imageLabel) || "[空富文本消息]";
    case "image":
      return imageLabel(textValue(content.image_key));
    case "file":
      return fileLabel(
        textValue(content.file_key),
        textValue(content.file_name ?? content.name),
      );
    case "folder":
      return namedPlaceholder("文件夹", content.title ?? content.name);
    case "audio":
      return "[语音]";
    case "media":
      return namedPlaceholder("视频", content.file_name ?? content.name);
    case "sticker":
      return "[表情包]";
    case "interactive":
      return renderInteractiveCard(content) || "[消息卡片]";
    case "share_chat":
      return "[群名片]";
    case "share_user":
      return "[个人名片]";
    case "location": {
      const detail = [textValue(content.name), textValue(content.address)].filter(Boolean).join(" · ");
      return detail ? `[位置] ${detail}` : "[位置]";
    }
    case "todo": {
      const summary = isRecord(content.summary) ? renderPost(content.summary, item.mentions, imageLabel) : "";
      return summary ? `[任务] ${summary}` : "[任务]";
    }
    case "vote": {
      const topic = textValue(content.topic);
      const options = Array.isArray(content.options)
        ? content.options.map(textValue).filter(Boolean).join(" / ")
        : "";
      return [`[投票]${topic ? ` ${topic}` : ""}`, options].filter(Boolean).join("\n");
    }
    case "system":
      return "[系统消息]";
    default:
      return `[暂不支持的消息类型：${messageType}]`;
  }
}

function messageTypeLabel(messageType: string): string {
  switch (messageType) {
    case "text": return "文本";
    case "post": return "富文本";
    case "image": return "图片";
    case "file": return "文件";
    case "folder": return "文件夹";
    case "audio": return "语音";
    case "media": return "视频";
    case "sticker": return "表情包";
    case "interactive": return "卡片";
    case "share_chat": return "群名片";
    case "share_user": return "个人名片";
    case "location": return "位置";
    case "todo": return "任务";
    case "vote": return "投票";
    case "system": return "系统消息";
    default: return messageType;
  }
}

function renderInteractiveCard(content: Record<string, unknown>): string {
  const values: string[] = [];
  collectCardText(content, undefined, values);
  return [...new Set(values.map((value) => normalizeFeishuPostText(value)).filter(Boolean))].join("\n");
}

function collectCardText(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === "string") {
    if (key === "content" || key === "text" || key === "title" || key === "subtitle") output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCardText(item, key, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectCardText(childValue, childKey, output);
  }
}

function renderPost(
  content: Record<string, unknown>,
  mentions: MergedForwardMessageItem["mentions"],
  imageLabel: (imageKey: string) => string,
): string {
  const locale = selectPostLocale(content);
  if (!locale) return "";
  const paragraphs: string[] = [];
  const title = normalizeFeishuPostText(textValue(locale.title));
  if (title) paragraphs.push(title);
  const rows = Array.isArray(locale.content) ? locale.content : locale.content_v2;
  if (!Array.isArray(rows)) return paragraphs.join("\n");
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    let rowText = "";
    let preserveFormatting = false;
    for (const rawElement of row) {
      if (!isRecord(rawElement)) continue;
      const tag = textValue(rawElement.tag);
      if (tag === "text") {
        rowText += textValue(rawElement.text);
      } else if (tag === "a") {
        const text = textValue(rawElement.text);
        const href = textValue(rawElement.href);
        rowText += href && href !== text ? `${text || href} (${href})` : text || href;
      } else if (tag === "md") {
        rowText += textValue(rawElement.text);
        preserveFormatting = true;
      } else if (tag === "code_block") {
        rowText += renderFeishuCodeBlock(textValue(rawElement.text), rawElement.language);
        preserveFormatting = true;
      } else if (tag === "at") {
        rowText += renderMention(rawElement, mentions);
      } else if (tag === "img") {
        rowText += imageLabel(textValue(rawElement.image_key));
      } else if (tag === "media") {
        rowText += "[媒体]";
      }
    }
    const normalized = preserveFormatting
      ? rowText.replace(/\r\n?/gu, "\n").trim()
      : normalizeFeishuPostText(rowText);
    if (normalized) paragraphs.push(normalized);
  }
  return paragraphs.join("\n");
}

function renderMention(
  element: Record<string, unknown>,
  mentions: MergedForwardMessageItem["mentions"],
): string {
  const explicitName = textValue(element.user_name ?? element.name);
  if (explicitName) return `@${explicitName}`;
  const userId = textValue(element.user_id ?? element.open_id);
  const resolved = mentions?.find((mention) => mention.id === userId)?.name;
  return resolved ? `@${resolved}` : "@成员";
}

function replaceMentions(text: string, mentions: MergedForwardMessageItem["mentions"]): string {
  let output = text;
  for (const mention of mentions ?? []) {
    if (!mention.key || !mention.name) continue;
    output = output.split(mention.key).join(`@${mention.name}`);
  }
  return output.trim();
}

function selectPostLocale(content: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Array.isArray(content.content) || Array.isArray(content.content_v2)) return content;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    if (isRecord(content[locale])) return content[locale];
  }
  return Object.values(content).find(isRecord);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function namedPlaceholder(kind: string, value: unknown): string {
  const name = textValue(value).trim();
  return name ? `[${kind}：${name}]` : `[${kind}]`;
}

function formatMessageTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}

function truncateMiddle(value: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  const characters = Array.from(value);
  if (characters.length <= limit) return { text: value, truncated: false };
  const marker = Array.from("\n\n... [合并转发内容过长，中间部分已截断] ...\n\n");
  if (limit <= marker.length) {
    return { text: marker.slice(0, limit).join(""), truncated: true };
  }
  const available = limit - marker.length;
  const headLength = Math.ceil(available * 0.45);
  const tailLength = available - headLength;
  return {
    text: [
      ...characters.slice(0, headLength),
      ...marker,
      ...(tailLength > 0 ? characters.slice(-tailLength) : []),
    ].join(""),
    truncated: true,
  };
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
