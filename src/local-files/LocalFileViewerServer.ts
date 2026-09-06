import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import hljs from "highlight.js/lib/common";
import dos from "highlight.js/lib/languages/dos";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";
import MarkdownIt from "markdown-it";
import {
  selectPreferredNetworkAddress,
  type NetworkConnectionKind,
} from "./NetworkAddressSelector.js";

const SECRET_FILE = "secret";
const PORT_FILE = "port";
const SHORT_TOKEN_BYTES = 12;
const SHORT_TOKEN_LENGTH = 16;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_SAMPLE_BYTES = 64 * 1024;
const MAX_SYNTAX_HIGHLIGHT_BYTES = 512 * 1024;
const DIRECTORY_PAGE_SIZE = 100;
const MARKDOWN_EXTENSIONS = new Set([".markdown", ".md", ".mdown", ".mkd", ".mkdn"]);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);

const MARKDOWN_RENDERER = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
  highlight(value, language) {
    const highlighted = language && hljs.getLanguage(language)
      ? hljs.highlight(value, { language, ignoreIllegals: true }).value
      : escapeHtml(value);
    const languageAttribute = language && hljs.getLanguage(language)
      ? ` class="language-${escapeAttribute(language)}"`
      : "";
    return `<pre class="markdown-code-block hljs"><code${languageAttribute}>${highlighted}</code></pre>`;
  },
});
MARKDOWN_RENDERER.renderer.rules.table_open = () =>
  '<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0"><table>\n';
MARKDOWN_RENDERER.renderer.rules.table_close = () => '</table></div>\n';

const HIGHLIGHT_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".bash": "bash", ".bat": "dos", ".c": "c", ".cc": "cpp", ".cmd": "dos", ".cpp": "cpp",
  ".cs": "csharp", ".css": "css", ".cxx": "cpp", ".diff": "diff", ".go": "go", ".h": "cpp",
  ".hpp": "cpp", ".htm": "xml", ".html": "xml", ".ini": "ini", ".ipynb": "json", ".java": "java",
  ".js": "javascript", ".json": "json", ".jsonl": "json", ".jsx": "javascript", ".kt": "kotlin",
  ".kts": "kotlin", ".less": "less", ".lua": "lua", ".markdown": "markdown", ".md": "markdown",
  ".mjs": "javascript", ".patch": "diff", ".php": "php", ".pl": "perl", ".ps1": "powershell",
  ".py": "python", ".r": "r", ".rb": "ruby", ".rs": "rust", ".scss": "scss", ".sh": "bash",
  ".sql": "sql", ".swift": "swift", ".toml": "ini", ".ts": "typescript", ".tsx": "typescript",
  ".vue": "xml", ".xml": "xml", ".yaml": "yaml", ".yml": "yaml", ".zsh": "bash",
};
const HIGHLIGHT_LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  ".env": "ini",
  ".gitignore": "ini",
  "dockerfile": "dockerfile",
  "makefile": "makefile",
};
const VIEWER_CLIENT_SCRIPT = `(() => {
  const eventsUrl = document.body.dataset.eventsUrl;
  const content = document.getElementById("viewer-content");
  const metadata = document.getElementById("viewer-metadata");
  const header = document.getElementById("viewer-header");
  const title = document.getElementById("viewer-title");
  const viewSwitch = document.getElementById("viewer-view-switch");
  const viewButtons = Array.from(document.querySelectorAll("[data-view-mode-button]"));
  if (!content || !metadata || !header || !title) return;
  const filePath = title.dataset.filePath || title.textContent || "";

  const syncViewMode = () => {
    const mode = document.body.dataset.viewMode === "code" ? "code" : "rendered";
    for (const button of viewButtons) {
      const active = button.dataset.viewModeButton === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const panel of content.querySelectorAll("[data-view-panel]")) {
      panel.setAttribute("aria-hidden", String(panel.dataset.viewPanel !== mode));
    }
  };
  const setViewMode = (mode) => {
    document.body.dataset.viewMode = mode === "code" ? "code" : "rendered";
    syncViewMode();
    if (mode === "code") requestAnimationFrame(positionHashTarget);
  };
  for (const button of viewButtons) {
    button.addEventListener("click", () => setViewMode(button.dataset.viewModeButton));
  }

  title.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(title);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const updateHeaderOffset = () => {
    const offset = Math.ceil(header.getBoundingClientRect().height) + 8;
    document.documentElement.style.setProperty("--viewer-header-offset", offset + "px");
  };
  const highlightHashTarget = () => {
    document.querySelector(".line.is-target-line")?.classList.remove("is-target-line");
    let id;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      title.textContent = filePath;
      return null;
    }
    const lineNumber = /^L(\\d+)$/.exec(id)?.[1];
    title.textContent = lineNumber ? filePath + ":" + lineNumber : filePath;
    if (!lineNumber) return null;
    const target = document.getElementById(id);
    target?.classList.add("is-target-line");
    return target;
  };
  const positionHashTarget = () => {
    highlightHashTarget()?.scrollIntoView({ block: "start" });
  };
  if (/^#L\\d+$/u.test(window.location.hash)) document.body.dataset.viewMode = "code";
  syncViewMode();
  updateHeaderOffset();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(updateHeaderOffset).observe(header);
  }
  window.addEventListener("hashchange", () => requestAnimationFrame(positionHashTarget));
  requestAnimationFrame(positionHashTarget);
  if (!eventsUrl || typeof EventSource !== "function") return;

  const restoreScroll = (top, left, atBottom, codeScrollLeft, tableScrollLeft) => {
    requestAnimationFrame(() => {
      const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(left, atBottom ? maxTop : Math.min(top, maxTop));
      const code = content.querySelector(".code");
      if (code) code.scrollLeft = codeScrollLeft;
      content.querySelectorAll(".markdown-table-scroll").forEach((table, index) => {
        table.scrollLeft = tableScrollLeft[index] ?? 0;
      });
    });
  };
  const replaceContent = (nextContent, nextMetadata) => {
    const top = window.scrollY;
    const left = window.scrollX;
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const atBottom = maxTop - top <= 24;
    const codeScrollLeft = content.querySelector(".code")?.scrollLeft ?? 0;
    const tableScrollLeft = Array.from(content.querySelectorAll(".markdown-table-scroll"), (table) => table.scrollLeft);
    content.innerHTML = nextContent;
    metadata.innerHTML = nextMetadata;
    syncViewMode();
    highlightHashTarget();
    restoreScroll(top, left, atBottom, codeScrollLeft, tableScrollLeft);
  };

  const source = new EventSource(eventsUrl);
  source.addEventListener("update", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (typeof update.content === "string" && typeof update.metadata === "string") {
        if (viewSwitch) viewSwitch.hidden = update.viewMode !== "markdown";
        replaceContent(update.content, update.metadata);
      }
    } catch {
      // A later valid event will repair the view.
    }
  });
  source.addEventListener("unavailable", (event) => {
    let message = "文件暂时无法读取，服务会继续等待它恢复。";
    try {
      const update = JSON.parse(event.data);
      if (typeof update.message === "string") message = update.message;
    } catch {
      // Keep the fallback message.
    }
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.textContent = message;
    replaceContent(notice.outerHTML, metadata.innerHTML);
  });
  window.addEventListener("pagehide", () => source.close(), { once: true });
})();
`;

type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

type FileContentClassification =
  | { kind: "text"; encoding: TextEncoding }
  | { kind: "binary" };

type DirectoryViewerEntryKind = "directory" | "text" | "image" | "pdf" | "media" | "binary";

interface DirectoryViewerEntry {
  name: string;
  path: string;
  stat: fs.Stats;
  kind: DirectoryViewerEntryKind;
}

interface RenderedFileSnapshot {
  content: string;
  metadata: string[];
  viewMode?: "markdown";
}

export interface LocalFileViewerServerOptions {
  host: string;
  port: number;
  publicBaseUrl?: string;
  stateDirectory: string;
}

export interface LocalFileViewerAddress {
  host: string;
  port: number;
  publicBaseUrl: string;
  publicInterface?: string;
  publicConnectionKind?: NetworkConnectionKind;
}

export class LocalFileViewerServer {
  private server?: http.Server;
  private secret?: Buffer;
  private address?: LocalFileViewerAddress;
  private basePath = "";

  constructor(private readonly options: LocalFileViewerServerOptions) {}

  async start(): Promise<LocalFileViewerAddress> {
    if (this.address) return this.address;

    fs.mkdirSync(this.options.stateDirectory, { recursive: true });
    this.secret = readOrCreateSecret(path.join(this.options.stateDirectory, SECRET_FILE));
    const configuredPublicBaseUrl = this.options.publicBaseUrl
      ? normalizePublicBaseUrl(this.options.publicBaseUrl)
      : undefined;

    const configuredPort = this.options.port;
    const persistedPort = configuredPort === 0
      ? readPersistedPort(path.join(this.options.stateDirectory, PORT_FILE))
      : undefined;
    const preferredPort = configuredPort || persistedPort || 0;
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.sendHtml(response, 500, errorPage("无法读取文件", "本地文件查看服务处理请求时发生错误。"));
      });
    });
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

    let selectedPort = preferredPort;
    try {
      await listen(server, this.options.host, selectedPort);
    } catch (error) {
      if (configuredPort !== 0 || preferredPort === 0 || !isAddressInUse(error)) throw error;
      selectedPort = 0;
      await listen(server, this.options.host, selectedPort);
    }

    const boundAddress = server.address();
    if (!boundAddress || typeof boundAddress === "string") {
      await closeServer(server);
      throw new Error("Local file viewer did not bind to a TCP port.");
    }

    try {
      const selectedNetwork = configuredPublicBaseUrl || !isWildcardHost(this.options.host)
        ? undefined
        : selectPreferredNetworkAddress();
      const publicHost = selectedNetwork?.address ?? urlHost(this.options.host);
      const publicBaseUrl = configuredPublicBaseUrl
        ?? normalizePublicBaseUrl(`http://${urlHost(publicHost)}:${boundAddress.port}`);
      this.basePath = normalizeBasePath(new URL(publicBaseUrl).pathname);
      if (configuredPort === 0 && persistedPort !== boundAddress.port) {
        fs.writeFileSync(path.join(this.options.stateDirectory, PORT_FILE), `${boundAddress.port}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      this.server = server;
      this.address = {
        host: this.options.host,
        port: boundAddress.port,
        publicBaseUrl,
        publicInterface: selectedNetwork?.interfaceName,
        publicConnectionKind: selectedNetwork?.kind,
      };
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    return this.address;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (server) await closeServer(server);
  }

  createFileUrl(filePath: string, reference?: string): string | undefined {
    if (!this.address || !this.secret) return undefined;
    const absolutePath = normalizeAbsolutePath(filePath);
    if (!absolutePath) return undefined;
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() && !stat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }

    const url = this.createPreviewUrl(absolutePath);
    const line = parseLineReference(reference);
    if (line !== undefined) url.hash = `L${line}`;
    return url.toString();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      this.sendHtml(response, 405, errorPage("不支持的请求", "该服务只接受只读请求。"), request.method === "HEAD");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = routeWithinBasePath(requestUrl.pathname, this.basePath);
    if (!route.startsWith("/")) {
      this.sendHtml(response, 404, errorPage("文件链接无效", "请从 Agent Bot 的回答中重新打开文件链接。"), request.method === "HEAD");
      return;
    }
    if (route === "/assets/viewer.js") {
      this.sendJavascript(response, request.method === "HEAD");
      return;
    }
    const previewMatch = new RegExp(`^/preview/([A-Za-z0-9_-]{${SHORT_TOKEN_LENGTH}})$`, "u").exec(route);
    const legacyMatch = /^\/(view|raw)\/([A-Za-z0-9_-]+)$/u.exec(route);
    const previewPath = previewMatch?.[1]
      ? this.verifyPreviewToken(previewMatch[1], requestUrl.searchParams.get("path") ?? "")
      : undefined;
    const legacyPath = legacyMatch?.[2]
      ? this.verifyLegacyToken(legacyMatch[2], requestUrl.searchParams.get("sig") ?? "")
      : undefined;
    const filePath = previewPath ?? legacyPath;
    if (!previewMatch && !legacyMatch) {
      this.sendHtml(response, 404, errorPage("文件链接无效", "请从 Agent Bot 的回答中重新打开文件链接。"), request.method === "HEAD");
      return;
    }
    if (!filePath) {
      this.sendHtml(response, 403, errorPage("文件链接无效", "签名校验失败，Agent Bot 已拒绝该请求。"), request.method === "HEAD");
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("Unsupported path type");
    } catch {
      this.sendHtml(response, 404, errorPage("文件不存在", "文件可能已被移动、重命名或删除。"), request.method === "HEAD");
      return;
    }

    if (requestUrl.searchParams.get("events") === "1") {
      if (!stat.isFile()) {
        this.sendHtml(response, 400, errorPage("无法监听目录", "实时更新目前只适用于文件。"), request.method === "HEAD");
        return;
      }
      this.serveFileEvents(request, response, filePath);
      return;
    }

    const raw = legacyMatch?.[1] === "raw" || requestUrl.searchParams.get("raw") === "1";
    if (raw) {
      if (stat.isDirectory()) {
        this.sendHtml(response, 400, errorPage("无法打开目录", "目录只能通过文件列表页面浏览。"), request.method === "HEAD");
        return;
      }
      this.serveRawFile(request, response, filePath, stat, requestUrl.searchParams.get("download") === "1");
      return;
    }

    const html = stat.isDirectory()
      ? this.renderDirectoryViewer(filePath, stat, parseDirectoryPage(requestUrl.searchParams.get("page")))
      : this.renderViewer(filePath, stat);
    this.sendHtml(response, 200, html, request.method === "HEAD");
  }

  private verifyLegacyToken(token: string, signature: string): string | undefined {
    if (!this.secret || !/^[a-f0-9]{64}$/u.test(signature)) return undefined;
    const expected = this.sign(token);
    const actualBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;

    let decoded: string;
    try {
      decoded = Buffer.from(token, "base64url").toString("utf8");
    } catch {
      return undefined;
    }
    if (!decoded || decoded.includes("\0") || Buffer.from(decoded, "utf8").toString("base64url") !== token) return undefined;
    return normalizeAbsolutePath(decoded);
  }

  private verifyPreviewToken(token: string, rawPath: string): string | undefined {
    const filePath = normalizeAbsolutePath(rawPath);
    if (!filePath || !this.secret) return undefined;
    const expected = this.createShortToken(filePath);
    const actualBuffer = Buffer.from(token, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
      ? filePath
      : undefined;
  }

  private sign(token: string): string {
    return createHmac("sha256", this.secret!).update(token).digest("hex");
  }

  private createLegacySignedUrl(route: "view" | "raw", token: string): URL {
    const url = new URL(this.address!.publicBaseUrl);
    url.pathname = `${this.basePath}/${route}/${token}`.replace(/\/{2,}/gu, "/");
    url.search = "";
    url.hash = "";
    url.searchParams.set("sig", this.sign(token));
    return url;
  }

  private createPreviewUrl(filePath: string): URL {
    const url = new URL(this.address!.publicBaseUrl);
    url.pathname = `${this.basePath}/preview/${this.createShortToken(filePath)}`
      .replace(/\/{2,}/gu, "/");
    url.search = `?path=${encodeReadableQueryPath(filePath)}`;
    url.hash = "";
    return url;
  }

  private createShortToken(filePath: string): string {
    return createHmac("sha256", this.secret!)
      .update(filePath)
      .digest()
      .subarray(0, SHORT_TOKEN_BYTES)
      .toString("base64url");
  }

  private renderViewer(filePath: string, stat: fs.Stats): string {
    const fileName = path.basename(filePath);
    const rawUrl = new URL(this.createFileUrl(filePath)!);
    rawUrl.hash = "";
    appendUrlQueryParameter(rawUrl, "raw", "1");
    const downloadUrl = new URL(rawUrl);
    appendUrlQueryParameter(downloadUrl, "download", "1");
    const eventsUrl = new URL(this.createFileUrl(filePath)!);
    eventsUrl.hash = "";
    appendUrlQueryParameter(eventsUrl, "events", "1");
    const snapshot = this.renderFileSnapshot(filePath, stat);

    return renderViewerPage({
      title: fileName,
      filePath,
      metadata: snapshot.metadata,
      actions: [
        { href: rawUrl.toString(), label: "打开原始文件" },
        { href: downloadUrl.toString(), label: "下载" },
      ],
      content: snapshot.content,
      viewMode: snapshot.viewMode,
      liveUpdates: {
        eventsUrl: eventsUrl.toString(),
        scriptPath: `${this.basePath}/assets/viewer.js`.replace(/\/{2,}/gu, "/"),
      },
    });
  }

  private renderFileSnapshot(filePath: string, stat: fs.Stats): RenderedFileSnapshot {
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const classification = classifyFileContent(filePath, stat.size);
    const contentType = binaryContentTypeFor(extension);
    const rawUrl = new URL(this.createFileUrl(filePath)!);
    rawUrl.hash = "";
    appendUrlQueryParameter(rawUrl, "raw", "1");

    let content: string;
    if (classification.kind === "text") {
      const preview = readTextPreview(filePath, stat.size, classification.encoding);
      const previewContent = isMarkdownFile(filePath)
        ? renderMarkdownDocument(preview.text, filePath)
        : renderText(preview.text, filePath);
      content = `${preview.truncated ? '<div class="notice">文件较大，仅显示开头 2 MiB。可使用下方按钮查看或下载完整文件。</div>' : ""}${previewContent}`;
    } else if (contentType.startsWith("image/")) {
      content = `<div class="media"><img src="${escapeAttribute(rawUrl.toString())}" alt="${escapeAttribute(fileName)}"></div>`;
    } else if (contentType === "application/pdf") {
      content = `<object class="document" data="${escapeAttribute(rawUrl.toString())}" type="application/pdf"><p>浏览器无法内嵌该 PDF，请打开原始文件。</p></object>`;
    } else if (contentType.startsWith("audio/")) {
      content = `<div class="media"><audio controls src="${escapeAttribute(rawUrl.toString())}"></audio></div>`;
    } else if (contentType.startsWith("video/")) {
      content = `<div class="media"><video controls src="${escapeAttribute(rawUrl.toString())}"></video></div>`;
    } else {
      content = '<div class="unsupported">该文件是二进制格式，无法直接预览。可以打开原始文件或下载到本地。</div>';
    }
    return {
      content,
      metadata: [formatFileSize(stat.size), stat.mtime.toLocaleString()],
      ...(classification.kind === "text" && isMarkdownFile(filePath)
        ? { viewMode: "markdown" as const }
        : {}),
    };
  }

  private serveFileEvents(request: IncomingMessage, response: ServerResponse, filePath: string): void {
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-cache, no-store");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("X-Accel-Buffering", "no");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.flushHeaders();
    response.write("retry: 2000\n\n");

    let closed = false;
    let pendingUpdate: NodeJS.Timeout | undefined;
    const sendSnapshot = () => {
      if (closed || response.destroyed) return;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("Path is no longer a file");
        const snapshot = this.renderFileSnapshot(filePath, stat);
        writeServerSentEvent(response, "update", JSON.stringify({
          content: snapshot.content,
          metadata: renderMetadata(snapshot.metadata),
          viewMode: snapshot.viewMode ?? null,
        }));
      } catch {
        writeServerSentEvent(response, "unavailable", JSON.stringify({
          message: "文件可能已被移动、重命名或删除。",
        }));
      }
    };
    const scheduleSnapshot = () => {
      if (pendingUpdate) clearTimeout(pendingUpdate);
      pendingUpdate = setTimeout(sendSnapshot, 100);
      pendingUpdate.unref();
    };
    const watcher = (current: fs.Stats, previous: fs.Stats) => {
      if (
        current.mtimeMs === previous.mtimeMs
        && current.ctimeMs === previous.ctimeMs
        && current.size === previous.size
        && current.nlink === previous.nlink
      ) return;
      scheduleSnapshot();
    };
    fs.watchFile(filePath, { interval: 1_000, persistent: false }, watcher);
    sendSnapshot();
    const keepAlive = setInterval(() => {
      if (!closed && !response.destroyed) response.write(": keep-alive\n\n");
    }, 15_000);
    keepAlive.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (pendingUpdate) clearTimeout(pendingUpdate);
      clearInterval(keepAlive);
      fs.unwatchFile(filePath, watcher);
    };
    request.once("aborted", cleanup);
    response.once("close", cleanup);
  }

  private renderDirectoryViewer(directory: string, stat: fs.Stats, requestedPage: number): string {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry): DirectoryViewerEntry[] => {
        const entryPath = path.join(directory, entry.name);
        try {
          const entryStat = fs.statSync(entryPath);
          if (!entryStat.isDirectory() && !entryStat.isFile()) return [];
          return [{
            name: entry.name,
            path: entryPath,
            stat: entryStat,
            kind: directoryViewerEntryKind(entryPath, entryStat),
          }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory")
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    const totalPages = Math.max(1, Math.ceil(entries.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages - 1);
    const visibleEntries = entries.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE);
    const rows = visibleEntries.length > 0
      ? visibleEntries.map((entry) => renderDirectoryEntry(entry, this.createFileUrl(entry.path)!)).join("")
      : '<div class="empty-directory">这个目录是空的。</div>';
    const pagination = totalPages > 1
      ? renderDirectoryPagination(page, totalPages, (targetPage) => {
          const url = new URL(this.createFileUrl(directory)!);
          appendUrlQueryParameter(url, "page", String(targetPage));
          return url.toString();
        })
      : "";
    const title = path.basename(directory) || directory;
    return renderViewerPage({
      title,
      filePath: directory,
      metadata: [`${entries.length} 项`, stat.mtime.toLocaleString()],
      actions: [],
      content: `<div class="directory-list">${rows}</div>${pagination}`,
    });
  }

  private serveRawFile(
    request: IncomingMessage,
    response: ServerResponse,
    filePath: string,
    stat: fs.Stats,
    download: boolean,
  ): void {
    const extension = path.extname(filePath).toLowerCase();
    const classification = classifyFileContent(filePath, stat.size);
    const contentType = classification.kind === "text"
      ? textContentTypeFor(extension, classification.encoding)
      : binaryContentTypeFor(extension);
    const range = parseRange(request.headers.range, stat.size);
    const fileName = path.basename(filePath);
    const disposition = download ? "attachment" : "inline";
    setSecurityHeaders(response);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    if (range === "invalid") {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      response.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stat.size - 1);
    const contentLength = stat.size === 0 ? 0 : end - start + 1;
    response.statusCode = range ? 206 : 200;
    response.setHeader("Content-Length", contentLength);
    if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (request.method === "HEAD" || stat.size === 0) {
      response.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", (error) => response.destroy(error));
    stream.pipe(response);
  }

  private sendHtml(response: ServerResponse, status: number, html: string, headOnly = false): void {
    const body = Buffer.from(html, "utf8");
    setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", body.length);
    response.end(headOnly ? undefined : body);
  }

  private sendJavascript(response: ServerResponse, headOnly: boolean): void {
    const body = Buffer.from(VIEWER_CLIENT_SCRIPT, "utf8");
    setSecurityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Content-Length", body.length);
    response.end(headOnly ? undefined : body);
  }
}

function renderViewerPage(input: {
  title: string;
  filePath: string;
  metadata: string[];
  actions: Array<{ href: string; label: string }>;
  content: string;
  viewMode?: "markdown";
  liveUpdates?: { eventsUrl: string; scriptPath: string };
}): string {
  const metadata = renderMetadata(input.metadata);
  const actions = input.actions.length > 0
    ? `<nav class="actions">${input.actions.map((action) => `<a href="${escapeAttribute(action.href)}">${escapeHtml(action.label)}</a>`).join("")}</nav>`
    : "";
  const viewSwitch = input.viewMode === "markdown"
    ? '<div class="view-switch" id="viewer-view-switch" role="tablist" aria-label="预览模式"><button class="is-active" type="button" role="tab" aria-selected="true" data-view-mode-button="rendered">预览</button><button type="button" role="tab" aria-selected="false" data-view-mode-button="code">代码</button></div>'
    : "";
  const toolbar = viewSwitch || actions
    ? `<div class="toolbar">${viewSwitch}${actions}</div>`
    : "";
  const liveAttributes = input.liveUpdates
    ? ` data-events-url="${escapeAttribute(input.liveUpdates.eventsUrl)}"`
    : "";
  const liveScript = input.liveUpdates
    ? `<script src="${escapeAttribute(input.liveUpdates.scriptPath)}" defer></script>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} · Agent Bot</title>
  <style>
    :root { --viewer-header-offset: 56px; --viewer-code-font: "Cascadia Mono", "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei Mono", NSimSun, monospace; color-scheme: light dark; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fa; color: #1f2329; }
    header { position: sticky; top: 0; z-index: 2; padding: 7px 12px; background: rgba(255,255,255,.96); border-bottom: 1px solid #dfe3e8; }
    h1 { margin: 0; cursor: text; font: 600 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; min-height: 26px; margin-top: 3px; color: #646a73; font-size: 11px; }
    .metadata-values { display: contents; }
    .toolbar { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .actions { display: flex; gap: 8px; }
    .actions a { color: #1456f0; text-decoration: none; padding: 3px 7px; border: 1px solid #c9d0db; border-radius: 4px; background: #fff; }
    .view-switch { display: inline-flex; padding: 2px; border: 1px solid #c9d0db; border-radius: 5px; background: #f2f3f5; }
    .view-switch[hidden] { display: none; }
    .view-switch button { min-width: 46px; padding: 2px 8px; border: 0; border-radius: 3px; background: transparent; color: #646a73; cursor: pointer; font: inherit; }
    .view-switch button.is-active { background: #fff; color: #1456f0; box-shadow: 0 1px 3px rgba(31,35,41,.16); }
    main { padding: 0; }
    .notice, .unsupported { margin: 8px; padding: 10px 12px; border: 1px solid #f3cf8f; background: #fff7e6; border-radius: 5px; }
    .code { margin: 0; padding: 6px 0; overflow: auto; border: 0; border-radius: 0; background: #fff; color: #1f2329; font-size: 13px; line-height: 1.5; tab-size: 2; }
    .code, .code code, .code .line, .code .line * { font-family: var(--viewer-code-font) !important; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }
    .line { display: block; min-height: 1.55em; padding-right: 16px; scroll-margin-top: var(--viewer-header-offset); }
    .line:target, .line.is-target-line { background: #fff1b8; box-shadow: inset 4px 0 #e6a700; }
    .line-number { display: inline-block; width: 4.5em; margin-right: 12px; padding-right: 12px; text-align: right; color: #8f959e; border-right: 1px solid #eceff3; text-decoration: none; user-select: none; }
    .hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #a626a4; }
    .hljs-string, .hljs-regexp, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition, .hljs-variable, .hljs-template-tag, .hljs-template-variable { color: #087f5b; }
    .hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #986801; }
    .hljs-title.function_, .hljs-title.class_ { color: #005cc5; }
    .hljs-deletion { color: #b31d28; background: #ffeef0; }
    .hljs-addition { background: #e6ffed; }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: 700; }
    body[data-view-mode="rendered"] [data-view-panel="code"], body[data-view-mode="code"] [data-view-panel="rendered"] { display: none; }
    .markdown-body { max-width: 980px; margin: 0 auto; padding: 20px 28px 48px; background: #fff; font-size: 15px; line-height: 1.72; overflow-wrap: anywhere; }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body > :last-child { margin-bottom: 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 { margin: 1.45em 0 .6em; line-height: 1.28; }
    .markdown-body h1 { padding-bottom: .35em; border-bottom: 1px solid #dfe3e8; font-size: 2em; }
    .markdown-body h2 { padding-bottom: .3em; border-bottom: 1px solid #eceff3; font-size: 1.5em; }
    .markdown-body h3 { font-size: 1.25em; }
    .markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body table, .markdown-body pre { margin: 0 0 1em; }
    .markdown-body ul, .markdown-body ol { padding-left: 1.8em; }
    .markdown-body li + li { margin-top: .28em; }
    .markdown-body blockquote { margin-left: 0; padding: .15em 1em; border-left: 4px solid #c9d0db; color: #646a73; }
    .markdown-body a { color: #1456f0; text-decoration: none; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body code { padding: .14em .35em; border-radius: 4px; background: #f2f3f5; font-family: var(--viewer-code-font); font-size: .9em; }
    .markdown-body .markdown-code-block { margin: 0 0 1em; padding: 14px 16px; overflow: auto; border-radius: 6px; background: #f6f8fa; line-height: 1.55; }
    .markdown-body .markdown-code-block code { padding: 0; background: transparent; font-size: 13px; }
    .markdown-table-scroll { max-width: 100%; margin: 0 0 1em; overflow-x: auto; }
    .markdown-table-scroll:focus-visible { outline: 2px solid #1456f0; outline-offset: 2px; }
    .markdown-body table { width: max-content; margin: 0; border-collapse: collapse; white-space: nowrap; overflow-wrap: normal; word-break: normal; }
    .markdown-body th, .markdown-body td { padding: 7px 12px; border: 1px solid #dfe3e8; text-align: left; }
    .markdown-body th { background: #f5f7fa; }
    .markdown-body img { max-width: 100%; height: auto; }
    .markdown-body hr { height: 1px; margin: 1.5em 0; border: 0; background: #dfe3e8; }
    .media { display: grid; place-items: center; min-height: 220px; }
    .media img, .media video { max-width: 100%; max-height: calc(100vh - 70px); }
    .media audio { width: min(720px, 100%); }
    .document { width: 100%; height: calc(100vh - 70px); border: 0; border-radius: 0; background: #fff; }
    .directory-list { overflow: hidden; border: 0; border-radius: 0; background: #fff; }
    .directory-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 18px; align-items: center; min-height: 44px; padding: 8px 14px; color: inherit; text-decoration: none; border-bottom: 1px solid #eceff3; }
    .directory-entry:last-child { border-bottom: 0; }
    .directory-entry:hover { background: #f0f4ff; }
    .entry-name { min-width: 0; overflow-wrap: anywhere; }
    .entry-kind, .entry-detail { color: #8f959e; font-size: 12px; white-space: nowrap; }
    .empty-directory { padding: 36px 18px; color: #8f959e; text-align: center; }
    .pagination { display: flex; justify-content: center; align-items: center; gap: 14px; margin-top: 16px; color: #646a73; font-size: 13px; }
    .pagination a { color: #1456f0; text-decoration: none; }
    @media (max-width: 640px) {
      .directory-entry { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
      .entry-detail { grid-column: 1 / -1; padding-left: 28px; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #17181a; color: #e5e6eb; }
      header { background: rgba(32,33,36,.96); border-color: #3a3b3d; }
      .meta, .pagination { color: #a6a9ad; }
      .actions a, .pagination a { color: #8ab4ff; }
      .actions a { border-color: #55585c; background: #292a2d; }
      .view-switch { border-color: #55585c; background: #292a2d; }
      .view-switch button { color: #a6a9ad; }
      .view-switch button.is-active { background: #3a3b3d; color: #8ab4ff; box-shadow: none; }
      .code, .directory-list { background: #202124; color: #e8eaed; border-color: #3a3b3d; }
      .markdown-body { background: #202124; color: #e8eaed; }
      .markdown-body h1, .markdown-body h2 { border-color: #3a3b3d; }
      .markdown-body blockquote { color: #a6a9ad; border-color: #55585c; }
      .markdown-body a { color: #8ab4ff; }
      .markdown-body code { background: #303134; }
      .markdown-body .markdown-code-block { background: #282a2d; }
      .markdown-body th, .markdown-body td { border-color: #55585c; }
      .markdown-body th { background: #292a2d; }
      .markdown-body hr { background: #3a3b3d; }
      .directory-entry { border-color: #3a3b3d; }
      .directory-entry:hover { background: #292f3d; }
      .line-number { color: #8b9098; border-color: #3a3b3d; }
      .line:target, .line.is-target-line { background: #594c20; box-shadow: inset 4px 0 #d29922; }
      .hljs-comment, .hljs-quote { color: #8b949e; }
      .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #ff7b72; }
      .hljs-string, .hljs-regexp, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition, .hljs-variable, .hljs-template-tag, .hljs-template-variable { color: #a5d6ff; }
      .hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #d2a8ff; }
      .hljs-title.function_, .hljs-title.class_ { color: #d2a8ff; }
      .hljs-deletion { color: #ffdcd7; background: #67060c; }
      .hljs-addition { color: #aff5b4; background: #033a16; }
      .notice, .unsupported { color: #f5d58a; background: #3b321c; border-color: #705b28; }
    }
  </style>
</head>
<body${input.viewMode === "markdown" ? ' data-view-mode="rendered"' : ""}${liveAttributes}>
  <header id="viewer-header">
    <h1 id="viewer-title" data-file-path="${escapeAttribute(input.filePath)}">${escapeHtml(input.filePath)}</h1>
    <div class="meta"><span class="metadata-values" id="viewer-metadata">${metadata}</span>${toolbar}</div>
  </header>
  <main id="viewer-content">${input.content}</main>
  ${liveScript}
</body>
</html>`;
}

function renderMetadata(metadata: string[]): string {
  return metadata.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function directoryViewerEntryKind(filePath: string, stat: fs.Stats): DirectoryViewerEntryKind {
  if (stat.isDirectory()) return "directory";
  if (classifyFileContent(filePath, stat.size).kind === "text") return "text";
  const contentType = binaryContentTypeFor(path.extname(filePath).toLowerCase());
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) return "media";
  return "binary";
}

function renderDirectoryEntry(entry: DirectoryViewerEntry, viewerUrl: string): string {
  const labels: Record<DirectoryViewerEntryKind, { icon: string; label: string }> = {
    directory: { icon: "📁", label: "目录" },
    text: { icon: "📄", label: "文本" },
    image: { icon: "🖼️", label: "图片" },
    pdf: { icon: "📕", label: "PDF" },
    media: { icon: "🎞️", label: "媒体" },
    binary: { icon: "📦", label: "二进制" },
  };
  const display = labels[entry.kind];
  const detail = entry.kind === "directory"
    ? entry.stat.mtime.toLocaleString()
    : `${formatFileSize(entry.stat.size)} · ${entry.stat.mtime.toLocaleString()}`;
  return `<a class="directory-entry" href="${escapeAttribute(viewerUrl)}"><span class="entry-name">${display.icon} ${escapeHtml(entry.name)}</span><span class="entry-kind">${display.label}</span><span class="entry-detail">${escapeHtml(detail)}</span></a>`;
}

function renderDirectoryPagination(
  page: number,
  totalPages: number,
  pageUrl: (page: number) => string,
): string {
  const previous = page > 0
    ? `<a href="${escapeAttribute(pageUrl(page - 1))}">上一页</a>`
    : "";
  const next = page + 1 < totalPages
    ? `<a href="${escapeAttribute(pageUrl(page + 1))}">下一页</a>`
    : "";
  return `<nav class="pagination">${previous}<span>第 ${page + 1}/${totalPages} 页</span>${next}</nav>`;
}

function readOrCreateSecret(filePath: string): Buffer {
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (/^[a-f0-9]{64}$/u.test(existing)) return Buffer.from(existing, "hex");
    throw new Error(`Invalid local file viewer secret: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32);
  try {
    fs.writeFileSync(filePath, `${secret.toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/u.test(existing)) throw new Error(`Invalid local file viewer secret: ${filePath}`);
    return Buffer.from(existing, "hex");
  }
}

function readPersistedPort(filePath: string): number | undefined {
  try {
    const port = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAbsolutePath(filePath: string): string | undefined {
  const normalized = /^\/[a-z]:[\\/]/iu.test(filePath) ? filePath.slice(1) : filePath;
  if (!path.isAbsolute(normalized)) return undefined;
  return path.resolve(normalized);
}

function encodeReadableQueryPath(filePath: string): string {
  return encodeURIComponent(filePath.replaceAll("\\", "/"))
    .replaceAll("%3A", ":")
    .replaceAll("%2F", "/");
}

function appendUrlQueryParameter(url: URL, name: string, value: string): void {
  const parameter = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  url.search = url.search ? `${url.search}&${parameter}` : `?${parameter}`;
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local file viewer publicBaseUrl must use http or https.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function normalizeBasePath(value: string): string {
  const pathName = value.replace(/\/+$/u, "");
  return pathName === "/" ? "" : pathName;
}

function routeWithinBasePath(pathName: string, basePath: string): string {
  if (!basePath) return pathName;
  if (!pathName.startsWith(`${basePath}/`)) return "";
  return pathName.slice(basePath.length);
}

function urlHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function parseLineReference(reference: string | undefined): number | undefined {
  if (!reference) return undefined;
  const match = /^:(\d+)(?::\d+)?$/u.exec(reference);
  if (!match?.[1]) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function parseDirectoryPage(value: string | null): number {
  if (!value || !/^\d+$/u.test(value)) return 0;
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

function readTextPreview(
  filePath: string,
  size: number,
  encoding: TextEncoding,
): { text: string; truncated: boolean } {
  const length = Math.min(size, MAX_TEXT_PREVIEW_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
    const truncated = size > bytesRead;
    return {
      text: decodeText(buffer.subarray(0, bytesRead), encoding, !truncated),
      truncated,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function classifyFileContent(filePath: string, size = fs.statSync(filePath).size): FileContentClassification {
  const length = Math.min(size, MAX_CONTENT_SAMPLE_BYTES);
  if (length === 0) return { kind: "text", encoding: "utf-8" };

  const sample = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(descriptor, sample, 0, length, 0);
    return classifyContentSample(sample.subarray(0, bytesRead), bytesRead >= size);
  } finally {
    fs.closeSync(descriptor);
  }
}

function classifyContentSample(sample: Buffer, complete: boolean): FileContentClassification {
  if (sample.length === 0) return { kind: "text", encoding: "utf-8" };

  if (sample.length >= 4 && (
    sample.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0x00, 0x00]))
    || sample.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0xfe, 0xff]))
  )) {
    return { kind: "binary" };
  }

  const bomEncoding = sample[0] === 0xff && sample[1] === 0xfe
    ? "utf-16le"
    : sample[0] === 0xfe && sample[1] === 0xff
      ? "utf-16be"
      : undefined;
  if (bomEncoding) {
    return isTextForEncoding(sample, bomEncoding, complete)
      ? { kind: "text", encoding: bomEncoding }
      : { kind: "binary" };
  }

  if (sample.includes(0)) return { kind: "binary" };

  for (const encoding of ["utf-8", "gb18030"] as const) {
    if (isTextForEncoding(sample, encoding, complete)) return { kind: "text", encoding };
  }
  return { kind: "binary" };
}

function isTextForEncoding(sample: Buffer, encoding: TextEncoding, complete: boolean): boolean {
  try {
    return hasTextLikeCharacters(decodeText(sample, encoding, complete, true));
  } catch {
    return false;
  }
}

function decodeText(
  value: Buffer,
  encoding: TextEncoding,
  complete: boolean,
  fatal = false,
): string {
  const decoder = new TextDecoder(encoding, { fatal });
  return decoder.decode(value, { stream: !complete });
}

function hasTextLikeCharacters(value: string): boolean {
  let controls = 0;
  let characters = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    characters += 1;
    if ((codePoint < 0x20 && ![0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b].includes(codePoint))
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      controls += 1;
    }
  }
  return controls <= 2 || controls / Math.max(1, characters) <= 0.02;
}

function renderText(value: string, filePath: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  const language = syntaxLanguageFor(filePath);
  const lines = language && Buffer.byteLength(normalized, "utf8") <= MAX_SYNTAX_HIGHLIGHT_BYTES
    ? highlightLines(normalized, language)
    : normalized.split("\n").map(escapeHtml);
  const languageClass = language ? ` class="language-${escapeAttribute(language)}"` : "";
  return `<pre class="code hljs"><code${languageClass}>${lines.map((line, index) => {
    const lineNumber = index + 1;
    return `<span class="line" id="L${lineNumber}"><a class="line-number" href="#L${lineNumber}">${lineNumber}</a>${line}</span>`;
  }).join("")}</code></pre>`;
}

function renderMarkdownDocument(value: string, filePath: string): string {
  return `<article class="markdown-body" data-view-panel="rendered">${MARKDOWN_RENDERER.render(value)}</article><section data-view-panel="code">${renderText(value, filePath)}</section>`;
}

function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function syntaxLanguageFor(filePath: string): string | undefined {
  const fileName = path.basename(filePath).toLowerCase();
  return HIGHLIGHT_LANGUAGE_BY_FILENAME[fileName]
    ?? HIGHLIGHT_LANGUAGE_BY_EXTENSION[path.extname(fileName)];
}

function highlightLines(value: string, language: string): string[] {
  try {
    return splitHighlightedLines(hljs.highlight(value, { language, ignoreIllegals: true }).value);
  } catch {
    return value.split("\n").map(escapeHtml);
  }
}

function splitHighlightedLines(value: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  const tokenPattern = /<span class="[^"]+">|<\/span>|\n/gu;
  let current = "";
  let offset = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? offset;
    current += value.slice(offset, index);
    offset = index + token.length;
    if (token === "\n") {
      current += "</span>".repeat(openTags.length);
      lines.push(current);
      current = openTags.join("");
    } else if (token === "</span>") {
      current += token;
      openTags.pop();
    } else {
      current += token;
      openTags.push(token);
    }
  }
  current += value.slice(offset);
  current += "</span>".repeat(openTags.length);
  lines.push(current);
  return lines;
}

function contentTypeFor(extension: string): string {
  const known: Record<string, string> = {
    ".aac": "audio/aac", ".avi": "video/x-msvideo", ".bmp": "image/bmp", ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".gif": "image/gif", ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".m4a": "audio/mp4",
    ".md": "text/markdown; charset=utf-8", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    ".mpeg": "video/mpeg", ".oga": "audio/ogg", ".ogg": "audio/ogg", ".ogv": "video/ogg", ".pdf": "application/pdf",
    ".png": "image/png", ".svg": "image/svg+xml", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".ts": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".wav": "audio/wav",
    ".webm": "video/webm", ".webp": "image/webp", ".xml": "application/xml; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  };
  return known[extension] ?? "application/octet-stream";
}

function binaryContentTypeFor(extension: string): string {
  const contentType = contentTypeFor(extension);
  return isTextContentType(contentType) ? "application/octet-stream" : contentType;
}

function textContentTypeFor(extension: string, encoding: TextEncoding): string {
  const contentType = contentTypeFor(extension);
  if (!isTextContentType(contentType)) return `text/plain; charset=${encoding}`;
  return contentType.replace(/;\s*charset=[^;]+/iu, `; charset=${encoding}`);
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType.includes("json")
    || contentType.includes("xml")
    || contentType.includes("yaml")
    || contentType === "image/svg+xml";
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return "invalid";

  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function writeServerSentEvent(response: ServerResponse, event: string, data: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\n`);
  for (const line of data.split(/\r?\n/u)) response.write(`data: ${line}\n`);
  response.write("\n");
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function errorPage(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Agent Bot</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:12vh auto;padding:0 24px;color:#1f2329}h1{font-size:24px}p{color:#646a73}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
