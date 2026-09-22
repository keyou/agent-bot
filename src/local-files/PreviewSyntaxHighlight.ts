import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import powershell from "highlight.js/lib/languages/powershell";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("powershell", powershell);

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { zsh: "bash", pwsh: "powershell" };
export const MAX_PREVIEW_HIGHLIGHT_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;

// Returning an empty string asks MarkdownIt to escape the original code unchanged.
export function highlightPreviewCode(value: string, language: string): string {
  const name = language.trim().toLowerCase();
  const resolved = Object.hasOwn(LANGUAGE_ALIASES, name) ? LANGUAGE_ALIASES[name]! : name;
  if (!resolved || !hljs.getLanguage(resolved) || Buffer.byteLength(value, "utf8") > MAX_PREVIEW_HIGHLIGHT_BYTES) return "";
  const key = `${resolved}\0${value}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.html;
  }
  try {
    const html = hljs.highlight(value, { language: resolved, ignoreIllegals: true }).value;
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(html, "utf8");
    if (bytes <= MAX_CACHE_BYTES) {
      while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      cache.set(key, { html, bytes });
      cacheBytes += bytes;
    }
    return html;
  } catch {
    return "";
  }
}

export const PREVIEW_SYNTAX_CSS = `
.markdown pre { --syntax-comment:#667080; --syntax-keyword:#9639a5; --syntax-string:#087f5b; --syntax-number:#986801; --syntax-title:#005cc5; --syntax-deletion:#b31d28; }
.markdown pre .hljs-comment, .markdown pre .hljs-quote { color:var(--syntax-comment); }
.markdown pre .hljs-keyword, .markdown pre .hljs-selector-tag, .markdown pre .hljs-literal, .markdown pre .hljs-section, .markdown pre .hljs-link { color:var(--syntax-keyword); }
.markdown pre .hljs-string, .markdown pre .hljs-regexp, .markdown pre .hljs-name, .markdown pre .hljs-type, .markdown pre .hljs-attribute, .markdown pre .hljs-symbol, .markdown pre .hljs-bullet, .markdown pre .hljs-addition, .markdown pre .hljs-variable, .markdown pre .hljs-template-tag, .markdown pre .hljs-template-variable { color:var(--syntax-string); }
.markdown pre .hljs-number, .markdown pre .hljs-meta, .markdown pre .hljs-built_in, .markdown pre .hljs-builtin-name, .markdown pre .hljs-params, .markdown pre .hljs-attr { color:var(--syntax-number); }
.markdown pre .hljs-title { color:var(--syntax-title); }
.markdown pre .hljs-deletion { color:var(--syntax-deletion); }
@media (prefers-color-scheme:dark) {
  .markdown pre { --syntax-comment:#8b949e; --syntax-keyword:#ff7b72; --syntax-string:#a5d6ff; --syntax-number:#d2a8ff; --syntax-title:#79c0ff; --syntax-deletion:#ffdcd7; }
}
`;
