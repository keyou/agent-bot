import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TerminalLinks } from "../../src/terminal/TerminalLinks.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const jobId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbot-terminal-links-")); directories.push(dir);
  const secret = randomBytes(32);
  const links = new TerminalLinks(dir, secret);
  return { dir, secret, links, file: (token: string) => path.join(dir, `${createHash("sha256").update(token).digest("hex")}.json`) };
}

test("eight-character links are stable, persistent and isolated between profiles", () => {
  const f = fixture(); const token = f.links.create(jobId);
  expect(token).toMatch(/^[A-Za-z0-9_-]{8}$/u);
  expect(f.links.create(jobId)).toBe(token);
  expect(f.links.resolve(token)).toBe(jobId);
  expect(new TerminalLinks(f.dir, f.secret).create(jobId)).toBe(token);
  expect(new TerminalLinks(f.dir, f.secret).resolve(token)).toBe(jobId);
  expect(f.links.create(otherId)).not.toBe(token);
  expect(fixture().links.resolve(token)).toBeUndefined();
  expect(fs.readdirSync(f.dir)).toHaveLength(2);
});

test("collisions never overwrite another command and the alternative token stays stable", () => {
  const f = fixture();
  const collision = createHmac("sha256", f.secret).update(`terminal:open:${jobId}:0`).digest("base64url").slice(0, 8);
  fs.writeFileSync(f.file(collision), JSON.stringify({ token: collision, jobId: otherId }));
  const token = f.links.create(jobId);
  expect(token).not.toBe(collision);
  expect(f.links.resolve(collision)).toBe(otherId);
  expect(f.links.resolve(token)).toBe(jobId);
  expect(new TerminalLinks(f.dir, f.secret).create(jobId)).toBe(token);
});

test("URL token case remains significant even on case-insensitive filesystems", () => {
  const f = fixture();
  fs.writeFileSync(f.file("Abcd1234"), JSON.stringify({ token: "Abcd1234", jobId }));
  fs.writeFileSync(f.file("abcd1234"), JSON.stringify({ token: "abcd1234", jobId: otherId }));
  expect(f.links.resolve("Abcd1234")).toBe(jobId);
  expect(f.links.resolve("abcd1234")).toBe(otherId);
});

test("malformed, unknown and tampered references fail closed without allocating links", () => {
  const f = fixture();
  for (const token of ["", "../other", "Abcd123", "Abcd12345", "Abcd1234"]) expect(f.links.resolve(token)).toBeUndefined();
  expect(fs.readdirSync(f.dir)).toHaveLength(0);
  for (const value of ["broken json", JSON.stringify({ token: "Abcd1234", jobId: "../escape" }), JSON.stringify({ token: "XXXXXXXX", jobId })]) {
    fs.writeFileSync(f.file("Abcd1234"), value);
    expect(f.links.resolve("Abcd1234")).toBeUndefined();
  }
  expect(() => f.links.create("../escape")).toThrow("Invalid terminal job ID");
});

test("damaged allocation records are preserved and bounded collision retries fail closed", () => {
  const f = fixture();
  for (let attempt = 0; attempt < 16; attempt++) {
    const token = createHmac("sha256", f.secret).update(`terminal:open:${jobId}:${attempt}`).digest("base64url").slice(0, 8);
    fs.writeFileSync(f.file(token), "corrupt");
  }
  expect(() => f.links.create(jobId)).toThrow("Unable to allocate");
  expect(fs.readdirSync(f.dir)).toHaveLength(16);
  for (const file of fs.readdirSync(f.dir)) expect(fs.readFileSync(path.join(f.dir, file), "utf8")).toBe("corrupt");
});

test("command and recovery tokens share one namespace without reusing expired recovery references", () => {
  const f = fixture();
  const reserved = createHmac("sha256", f.secret).update(`terminal:open:${jobId}:0`).digest("base64url").slice(0, 8);
  fs.writeFileSync(f.file(reserved), JSON.stringify({ token: reserved, recovery: true }));
  const restarted = new TerminalLinks(f.dir, f.secret);
  expect(restarted.resolve(reserved)).toBeUndefined();
  const command = restarted.create(jobId);
  const recovery = restarted.createRecovery();
  expect(command).not.toBe(reserved);
  expect(recovery).toMatch(/^[A-Za-z0-9_-]{8}$/u);
  expect(recovery).not.toBe(command); expect(recovery).not.toBe(reserved);
  expect(restarted.resolve(command)).toBe(jobId);
  expect(restarted.resolve(recovery)).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(f.file(recovery), "utf8"))).toEqual({ token: recovery, recovery: true });
  expect(new TerminalLinks(f.dir, f.secret).create(jobId)).toBe(command);
  expect(JSON.parse(fs.readFileSync(f.file(reserved), "utf8"))).toEqual({ token: reserved, recovery: true });
});
