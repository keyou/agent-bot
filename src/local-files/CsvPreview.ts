const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARACTERS = 4_000;

export interface CsvPreview {
  rows: string[][];
  notices: string[];
}

export function csvSourcePreview(source: string): { text: string; truncated: boolean } {
  const text = source.replace(/\r\n?/gu, "\n");
  let offset = 0;
  for (let line = 0; line < 2_000; line += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0 || newline === text.length - 1) return { text, truncated: false };
    offset = newline + 1;
  }
  return { text: text.slice(0, offset - 1), truncated: true };
}

// Parse records rather than physical lines: quoted CSV fields may contain newlines.
export function parseCsvPreview(source: string, sourceTruncated = false): CsvPreview {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows: string[][] = [];
  const notices = new Set<string>();
  let row: string[] = [];
  let field = "";
  let fieldCharacters = 0;
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let recordStarted = false;
  const append = (character: string): void => {
    if (row.length >= MAX_COLUMNS) return;
    if (fieldCharacters < MAX_CELL_CHARACTERS) { field += character; fieldCharacters += 1; }
    else notices.add(`过长单元格仅显示前 ${MAX_CELL_CHARACTERS} 个字符。`);
  };
  const endField = (): void => {
    if (row.length < MAX_COLUMNS) row.push(field);
    else notices.add(`表格仅显示前 ${MAX_COLUMNS} 列。`);
    field = "";
    fieldCharacters = 0;
    state = "start";
  };
  if (sourceTruncated) notices.add("文件较大，仅读取开头 2 MiB；末尾不完整的记录不显示。可下载完整文件。");
  let invalid = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    if (character.length === 2) index += 1;
    recordStarted = true;
    if (state === "quoted") {
      if (character === '"') state = "closed";
      else append(character);
      continue;
    }
    if (character === '"') {
      if (state === "start") state = "quoted";
      else if (state === "closed") { append(character); state = "quoted"; }
      else { invalid = true; break; }
    } else if (character === ",") {
      endField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endField();
      rows.push(row);
      row = [];
      recordStarted = false;
      if (rows.length === MAX_ROWS && index + 1 < text.length) {
        notices.add(`表格仅显示前 ${MAX_ROWS} 行。`);
        return { rows, notices: [...notices] };
      }
    } else if (state === "closed") {
      invalid = true;
      break;
    } else {
      state = "plain";
      append(character);
    }
  }
  if (invalid || (!sourceTruncated && state === "quoted")) {
    notices.add(`第 ${rows.length + 1} 条记录的引号格式不完整或不合法，已停止解析。请切换代码查看原文。`);
  } else if (recordStarted && !sourceTruncated) {
    endField();
    rows.push(row);
  }
  return { rows, notices: [...notices] };
}

export function renderCsvPreview(source: string, sourceTruncated = false): string {
  const { rows, notices } = parseCsvPreview(source, sourceTruncated);
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const noticesHtml = notices.map((notice) => `<div class="notice">${escapeHtml(notice)}</div>`).join("");
  if (!rows.length) {
    return `<section data-view-panel="rendered">${noticesHtml}<div class="csv-summary">${notices.length ? "没有可显示的完整记录。" : "CSV 文件为空。"}</div></section>`;
  }
  const headings = Array.from({ length: columns }, (_, index) => {
    const label = index < 26 ? String.fromCharCode(65 + index) : `A${String.fromCharCode(65 + index - 26)}`;
    return `<th scope="col">${label}</th>`;
  }).join("");
  const body = rows.map((row, index) => {
    const cells = row.map((value) => `<td><div class="csv-cell">${escapeHtml(value)}</div></td>`).join("");
    const missing = columns - row.length;
    return `<tr><th scope="row">${index + 1}</th>${cells}${missing ? `<td colspan="${missing}" class="csv-missing"></td>` : ""}</tr>`;
  }).join("");
  return `<section data-view-panel="rendered">${noticesHtml}<div class="csv-summary">已显示 ${rows.length} 行 · 最多 ${columns} 列 · 首行保留为数据</div><div class="csv-table-scroll" role="region" aria-label="CSV 表格" tabindex="0"><table class="csv-table"><thead><tr><th scope="col" aria-label="行号">#</th>${headings}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export const CSV_PREVIEW_CSS = `
    .csv-summary { padding: 10px 12px; color: #646a73; font-size: 12px; }
    .csv-table-scroll { isolation: isolate; max-width: 100%; max-height: calc(100dvh - var(--viewer-header-offset) - 40px); overflow: auto; background: #fff; }
    .csv-table-scroll:focus-visible { outline: 2px solid #1456f0; outline-offset: -2px; }
    .csv-table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; line-height: 1.5; }
    .csv-table th, .csv-table td { padding: 7px 12px; text-align: left; vertical-align: top; border-right: 1px solid #dfe3e8; border-bottom: 1px solid #dfe3e8; }
    .csv-table th { background: #f0f3f8; font-weight: 600; }
    .csv-table thead th { position: sticky; top: 0; z-index: 1; }
    .csv-table tr > th:first-child { position: sticky; left: 0; text-align: right; min-width: 3.5em; }
    .csv-table thead th:first-child { z-index: 2; }
    .csv-table tbody tr:nth-child(even) td { background: #f9fafc; }
    .csv-table tbody tr:hover td { background: #edf3ff; }
    .csv-cell { min-width: 4em; max-width: 32rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 640px) { .csv-cell { max-width: 20rem; } }
    @media (prefers-color-scheme: dark) {
      .csv-summary { color: #a6a9ad; }
      .csv-table-scroll { background: #202124; }
      .csv-table th, .csv-table td { border-color: #55585c; }
      .csv-table th { background: #292a2d; }
      .csv-table tbody tr:nth-child(even) td { background: #252629; }
      .csv-table tbody tr:hover td { background: #292f3d; }
    }
`;
