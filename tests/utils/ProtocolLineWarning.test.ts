import { expect, test, vi } from "vitest";
import type { Logger } from "pino";
import { ProtocolLineWarning } from "../../src/utils/ProtocolLineWarning.js";

test("bounds invalid protocol diagnostics and aggregates suppressed lines", () => {
  const warn = vi.fn();
  const limiter = new ProtocolLineWarning();
  const logger = { warn } as unknown as Logger;
  limiter.warn(logger, "x".repeat(100_000), "invalid", 0);
  for (let i = 1; i < 100; i++) limiter.warn(logger, "noise", "invalid", i);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toMatchObject({ characters: 100_000, line: "x".repeat(2048) });
  limiter.warn(logger, "new", "invalid", 10_000);
  expect(warn.mock.calls[1]?.[0]).toMatchObject({ suppressed: 99, line: "new" });
});
