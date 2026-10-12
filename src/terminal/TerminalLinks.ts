import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const record = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{8}$/u), jobId: z.string().regex(/^[a-f0-9-]{36}$/u) });

export class TerminalLinks {
  constructor(private readonly directory: string, private readonly secret: Buffer) {
    fs.mkdirSync(directory, { recursive: true });
  }

  create(jobId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(jobId)) throw new Error("Invalid terminal job ID.");
    for (let attempt = 0; attempt < 16; attempt++) {
      const token = createHmac("sha256", this.secret).update(`terminal:open:${jobId}:${attempt}`).digest("base64url").slice(0, 8);
      if (this.resolve(token) === jobId) return token;
      try {
        fs.writeFileSync(this.filePath(token), JSON.stringify({ token, jobId }), { flag: "wx", mode: 0o600 });
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.resolve(token) === jobId) return token;
      }
    }
    throw new Error("Unable to allocate a terminal short link.");
  }

  createRecovery(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const token = randomBytes(6).toString("base64url");
      try {
        // Reserve the shared namespace permanently: an expired recovery must never open a new Shell.
        fs.writeFileSync(this.filePath(token), JSON.stringify({ token, recovery: true }), { flag: "wx", mode: 0o600 });
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Unable to allocate a terminal recovery link.");
  }

  resolve(token: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{8}$/u.test(token)) return undefined;
    let content: string;
    try { content = fs.readFileSync(this.filePath(token), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(content) as unknown; } catch { return undefined; }
    const parsed = record.safeParse(value);
    return parsed.success && parsed.data.token === token ? parsed.data.jobId : undefined;
  }

  private filePath(token: string): string {
    // Hash filenames so case-sensitive URL tokens also work on Windows filesystems.
    return path.join(this.directory, `${createHash("sha256").update(token).digest("hex")}.json`);
  }
}
