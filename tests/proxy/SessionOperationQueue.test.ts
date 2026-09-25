import { expect, test } from "vitest";
import { SessionOperationQueue } from "../../src/proxy/SessionOperationQueue.js";

test("serializes one task, isolates other tasks, and continues after failure", async () => {
  const queue = new SessionOperationQueue();
  const order: string[] = [];
  let release!: () => void;
  const first = queue.run("task", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    order.push("first");
    throw new Error("failed");
  });
  const rejected = expect(first).rejects.toThrow("failed");
  const second = queue.run("task", async () => { order.push("second"); });
  await queue.run("another", async () => { order.push("independent"); });
  expect(order).toEqual(["independent"]);
  release();
  await rejected;
  await second;
  expect(order).toEqual(["independent", "first", "second"]);
});
