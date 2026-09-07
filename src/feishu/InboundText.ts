export function normalizeFeishuPostText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<p(?:\s[^>]*)?>/giu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function renderFeishuCodeBlock(text: string, language: unknown): string {
  const code = text.replace(/\r\n?/gu, "\n").replace(/\n+$/gu, "");
  if (!code) return "";
  const longestBacktickRun = Math.max(0, ...[...code.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const languageHint = typeof language === "string" && /^[A-Za-z0-9_+#.-]+$/u.test(language.trim())
    ? language.trim().toLowerCase()
    : "";
  return `${fence}${languageHint}\n${code}\n${fence}`;
}
