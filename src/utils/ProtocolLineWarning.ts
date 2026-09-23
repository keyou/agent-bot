import type { Logger } from "pino";

/** Invalid protocol output is diagnostic metadata, not a second full execution log. */
export class ProtocolLineWarning {
  private nextWarningAt = 0;
  private suppressed = 0;
  warn(logger: Logger, line: string, message: string, now = Date.now()): void {
    if (now < this.nextWarningAt) { this.suppressed++; return; }
    logger.warn({ line: line.slice(0, 2048), characters: line.length, suppressed: this.suppressed }, message);
    this.suppressed = 0;
    this.nextWarningAt = now + 10_000;
  }
}
