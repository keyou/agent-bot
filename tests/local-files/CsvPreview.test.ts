import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { csvSourcePreview, parseCsvPreview, renderCsvPreview } from "../../src/local-files/CsvPreview.js";

describe("CSV preview", () => {
  test.each([
    ["", []],
    ["\ufeff", []],
    ["one", [["one"]]],
    ["name,value\n苹果,0012\n", [["name", "value"], ["苹果", "0012"]]],
    ["\ufeffa,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]],
    ["a,b\r1,2\r", [["a", "b"], ["1", "2"]]],
    ['"a,b","say ""hi"""', [["a,b", 'say "hi"']]],
    ['"line 1\r\nline 2",x', [["line 1\r\nline 2", "x"]]],
    [",,\n1,\n\n", [["", "", ""], ["1", ""], [""]]],
    ['"",""', [["", ""]]],
    ["  spaced  ,1e6,=SUM(A1:A2)", [["  spaced  ", "1e6", "=SUM(A1:A2)"]]],
  ])("parses records without coercing data: %j", (source, rows) => {
    expect(parseCsvPreview(source).rows).toEqual(rows);
  });

  test.each(['a,b\n"unfinished', 'a,b\nplain"quote,x', 'a,b\n"closed"tail,x', 'a,b\n"", ""'])("reports malformed quotes instead of silently corrupting data: %j", (source) => {
    const parsed = parseCsvPreview(source);
    expect(parsed.rows).toEqual([["a", "b"]]);
    expect(parsed.notices.join()).toContain("第 2 条记录");
  });

  test.each(['a,b\n1,partial', 'a,b\n1,"partial\nmore', 'a,b\n1,"closed"'])("drops the last partial record at the byte limit: %j", (source) => {
    const parsed = parseCsvPreview(source, true);
    expect(parsed.rows).toEqual([["a", "b"]]);
    expect(parsed.notices.join()).toContain("2 MiB");
    expect(parsed.notices.join()).not.toContain("引号格式");
  });

  test("keeps all complete records before a truncated boundary", () => {
    expect(parseCsvPreview("a,b\n1,2\n", true).rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  test("bounds rows, columns and cells independently", () => {
    expect(parseCsvPreview("a\n".repeat(500)).notices).toEqual([]);
    const rows = parseCsvPreview("a\n".repeat(501));
    expect(rows.rows).toHaveLength(500);
    expect(rows.notices.join()).toContain("500 行");
    const columns = parseCsvPreview(Array.from({ length: 1000 }, (_, index) => String(index)).join(","));
    expect(columns.rows[0]).toHaveLength(50);
    expect(columns.rows[0]?.at(-1)).toBe("49");
    expect(columns.notices.join()).toContain("50 列");
    const cell = parseCsvPreview(`"${"x".repeat(100_000)}",next\nend,row`);
    expect(cell.rows[0]?.[0]).toHaveLength(4000);
    expect(cell.rows[0]?.[1]).toBe("next");
    expect(cell.rows[1]).toEqual(["end", "row"]);
    expect(cell.notices.join()).toContain("4000");
  });

  test("escapes HTML and displays formulas, URLs and leading zeros as inert text", () => {
    const { document } = parseHTML(renderCsvPreview('name,value\n<img src=x onerror=alert(1)>,=1+1\nhttps://example.com,0012'));
    expect(document.querySelector("img,script,a")).toBeNull();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
    expect([...document.querySelectorAll(".csv-cell")].map((cell) => cell.textContent)).toEqual(["name", "value", "<img src=x onerror=alert(1)>", "=1+1", "https://example.com", "0012"]);
    expect(document.querySelector("thead")?.textContent).toBe("#AB");
    expect(document.querySelectorAll('th[scope="row"]')).toHaveLength(3);
  });

  test("cell truncation keeps complete Unicode code points", () => {
    const result = parseCsvPreview(`${"x".repeat(3999)}😀tail,next`);
    expect(result.rows[0]?.[0]).toBe(`${"x".repeat(3999)}😀`);
    expect(result.rows[0]?.[1]).toBe("next");
    expect(result.notices.join()).toContain("4000");
  });

  test("keeps ragged rows without discarding extra columns or inventing cell values", () => {
    const { document } = parseHTML(renderCsvPreview("a,b\n1,2,3\n4"));
    expect(document.querySelectorAll("thead th")).toHaveLength(4);
    expect([...document.querySelectorAll(".csv-cell")].map((cell) => cell.textContent)).toEqual(["a", "b", "1", "2", "3", "4"]);
    expect(document.querySelector('td[colspan="2"]')).not.toBeNull();
  });

  test("has an explicit empty state", () => {
    expect(renderCsvPreview("")).toContain("CSV 文件为空");
    expect(renderCsvPreview("")).not.toContain("<table");
  });

  test("bounds hidden code-view DOM by physical lines without splitting all lines", () => {
    expect(csvSourcePreview("a,b\r\n1,2")).toEqual({ text: "a,b\n1,2", truncated: false });
    expect(csvSourcePreview("a\n".repeat(2000)).truncated).toBe(false);
    const preview = csvSourcePreview("a\n".repeat(500_000));
    expect(preview.truncated).toBe(true);
    expect(preview.text.split("\n")).toHaveLength(2000);
  });
});
