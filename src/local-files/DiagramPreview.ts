import type MarkdownIt from "markdown-it";

export function enableDiagramFences(markdown: InstanceType<typeof MarkdownIt>): void {
  const original = markdown.renderer.rules.fence!;
  markdown.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
    const token = tokens[index]!;
    if (!/^(mermaid|flowchart)$/iu.test(token.info.trim())) return original(tokens, index, options, environment, renderer);
    const zh = environment?.language !== "en";
    const source = markdown.utils.escapeHtml(token.content);
    return `<div class="diagram" data-diagram data-diagram-size="fit" data-preview-key="diagram:${index}">
      <div class="diagram-toolbar" role="group" aria-label="${zh ? "图表显示模式" : "Diagram display mode"}">
        <button type="button" data-diagram-mode="preview" aria-pressed="true">${zh ? "预览" : "Preview"}</button>
        <button type="button" data-diagram-mode="source" aria-pressed="false">${zh ? "源码" : "Source"}</button>
        <button type="button" data-diagram-size-toggle hidden>${zh ? "原大" : "Actual size"}</button>
      </div>
      <p class="diagram-notice" role="status">${zh ? "正在渲染图表…" : "Rendering diagram…"}</p>
      <div class="diagram-preview" role="img" aria-label="${zh ? "Mermaid 图表" : "Mermaid diagram"}"></div>
      <pre class="diagram-source" hidden><code>${source}</code></pre>
      <noscript><pre><code>${source}</code></pre></noscript>
    </div>`;
  };
}

export const DIAGRAM_PREVIEW_CSS = `
.diagram { --diagram-max-height:min(640px, 70vh); border:1px solid var(--border, #d8dee8); border-radius:12px; overflow:hidden; margin:12px 0; }
.diagram-toolbar { display:flex; flex-wrap:wrap; gap:4px; padding:6px 8px; border-bottom:1px solid var(--border, #d8dee8); }
.diagram-toolbar button { font:inherit; font-size:12px; color:inherit; background:transparent; border:1px solid transparent; border-radius:6px; padding:3px 10px; cursor:pointer; }
.diagram-toolbar button[aria-pressed="true"] { border-color:currentColor; }
.diagram-toolbar [data-diagram-size-toggle] { margin-left:auto; }
.diagram-toolbar button:focus-visible { outline:2px solid #4285d4; outline-offset:1px; }
.diagram-notice { font-size:12px; opacity:.75; margin:8px 12px!important; }
.diagram-preview { padding:12px; overflow:auto; max-height:var(--diagram-max-height); }
.diagram-preview svg { display:block; margin:auto; max-width:none!important; height:auto; width:min(100%, var(--diagram-width, 100%))!important; }
.diagram[data-diagram-size="actual"] .diagram-preview svg { width:var(--diagram-width, 100%)!important; }
@media (max-width:640px), (pointer:coarse) {
  .diagram { --diagram-max-height:min(480px, 55vh); }
  @supports (height:1svh) { .diagram { --diagram-max-height:min(480px, 55svh); } }
}
.diagram .diagram-source { margin:0; border:0; border-radius:0; max-height:30em; overflow:auto; white-space:pre; }
.diagram [hidden] { display:none!important; }
@media (hover:none), (pointer:coarse) { .diagram-preview, .diagram-source { scrollbar-width:none; } .diagram-preview::-webkit-scrollbar, .diagram-source::-webkit-scrollbar { display:none; } }
`;

export const DIAGRAM_PREVIEW_CLIENT_SCRIPT = String.raw`(() => {
  const zh = /^zh/i.test(document.documentElement.lang);
  const loading = zh ? "正在渲染图表…" : "Rendering diagram…";
  const failed = zh ? "图表暂时无法渲染，已显示源码。" : "Diagram could not be rendered. Showing source.";
  const states = new WeakMap();
  let library;
  let sequence = 0;
  const loadLibrary = () => {
    if (!library) library = new Promise((resolve, reject) => {
      const url = document.body.dataset.diagramScript;
      if (!url) { reject(new Error("Diagram renderer unavailable")); return; }
      const script = document.createElement("script");
      script.src = url;
      const timeout = setTimeout(() => {
        script.remove();
        reject(new Error("Diagram renderer timed out"));
      }, 15000);
      script.onload = () => {
        clearTimeout(timeout);
        const mermaid = window.mermaid;
        if (!mermaid) { reject(new Error("Diagram renderer unavailable")); return; }
        try {
          mermaid.initialize({
            startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
            maxTextSize: 50000, maxEdges: 500, htmlLabels: false,
            flowchart: { htmlLabels: false },
            theme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
            secure: ["securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "flowchart", "secure"],
          });
          resolve(mermaid);
        } catch (error) { reject(error); }
      };
      script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error("Diagram renderer unavailable")); };
      document.head.appendChild(script);
    }).catch((error) => { library = undefined; throw error; });
    return library;
  };
  const show = (block, state) => {
    const mode = state.error ? "source" : state.mode;
    block.querySelector(".diagram-preview").hidden = mode !== "preview";
    block.querySelector(".diagram-source").hidden = mode !== "source";
    block.dataset.diagramSize = state.size;
    const sizeButton = block.querySelector("[data-diagram-size-toggle]");
    sizeButton.hidden = mode !== "preview" || state.rendered !== state.source;
    sizeButton.textContent = state.size === "actual" ? (zh ? "适应" : "Fit") : (zh ? "原大" : "Actual size");
    sizeButton.setAttribute("aria-label", state.size === "actual"
      ? (zh ? "适应容器宽度" : "Fit diagram to width")
      : (zh ? "按原始尺寸查看图表" : "View diagram at actual size"));
    const notice = block.querySelector(".diagram-notice");
    notice.hidden = !state.error && (state.rendered === state.source || mode === "source");
    notice.textContent = state.error ? failed : loading;
    block.querySelectorAll("[data-diagram-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.diagramMode === mode));
    });
  };
  const render = async (block, state, revision) => {
    const source = state.source;
    let container;
    try {
      // Keep model-authored Mermaid config from weakening the renderer's safety policy.
      if (source.length > 50000 || /^\s*---(?:\r?\n|$)/u.test(source) || /%%\s*\{/u.test(source)) {
        throw new Error("Diagram configuration or size is unsupported");
      }
      const mermaid = await loadLibrary();
      if (!block.isConnected || state.revision !== revision) return;
      container = document.createElement("div");
      container.style.cssText = "position:absolute;left:-100000px;top:0;width:1000px;visibility:hidden;pointer-events:none";
      document.body.appendChild(container);
      const result = await mermaid.render("agentbot-diagram-" + (++sequence), source, container);
      if (!block.isConnected || state.revision !== revision) return;
      const template = document.createElement("template");
      template.innerHTML = result.svg;
      // Mermaid's strict renderer sanitizes SVG. Also prohibit links, images and callbacks.
      template.content.querySelectorAll("script,foreignObject,iframe,object,embed,image").forEach((node) => node.remove());
      template.content.querySelectorAll("*").forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
          if (/^on/i.test(attr.name) || /^(href|xlink:href|src)$/i.test(attr.name) && !attr.value.startsWith("#")) node.removeAttribute(attr.name);
        }
      });
      const svg = template.content.querySelector("svg");
      if (!svg) throw new Error("Missing SVG");
      const viewBox = (svg.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number);
      if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
        svg.style.setProperty("--diagram-width", viewBox[2] + "px");
      }
      block.querySelector(".diagram-preview").replaceChildren(template.content);
      state.rendered = source;
      state.error = false;
      show(block, state);
    } catch {
      if (block.isConnected && state.revision === revision) { state.error = true; show(block, state); }
    } finally { if (container) container.remove(); }
  };
  const schedule = (block, state) => {
    clearTimeout(state.timer);
    state.revision += 1;
    if (state.mode !== "preview" || state.rendered === state.source) return;
    const revision = state.revision;
    state.timer = setTimeout(() => void render(block, state, revision), 180);
  };
  const refresh = (block) => {
    const source = block.querySelector(".diagram-source code").textContent;
    let state = states.get(block);
    if (!state) {
      state = { source, mode: "preview", size: "fit", revision: 0, error: false };
      states.set(block, state);
      block.querySelector("[data-diagram-size-toggle]").addEventListener("click", () => {
        state.size = state.size === "actual" ? "fit" : "actual";
        const preview = block.querySelector(".diagram-preview");
        preview.scrollLeft = 0;
        preview.scrollTop = 0;
        show(block, state);
      });
      block.querySelectorAll("[data-diagram-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          state.mode = button.dataset.diagramMode;
          if (state.mode === "preview") state.error = false;
          show(block, state);
          schedule(block, state);
        });
      });
    } else if (state.source === source) { return; }
    else { state.source = source; state.error = false; }
    show(block, state);
    schedule(block, state);
  };
  const scan = () => document.querySelectorAll("[data-diagram]").forEach(refresh);
  window.agentBotDiagrams = { refresh, scan };
  scan();
})();`;
