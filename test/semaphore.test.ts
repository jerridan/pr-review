import { describe, expect, it } from "vitest";
import { createSemaphore } from "../src/semaphore.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSemaphore", () => {
  it("runs at most limit tasks at once and returns each result", async () => {
    const run = createSemaphore(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
          return i * 2;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it("starts waiting tasks in the order they arrive", async () => {
    const run = createSemaphore(1);
    const started: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const all = gates.map((gate, i) =>
      run(async () => {
        started.push(i);
        await gate.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0]);
    gates[0]?.resolve();
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(all);
    expect(started).toEqual([0, 1, 2]);
  });

  it("frees the slot when a task rejects, and passes the rejection on", async () => {
    const run = createSemaphore(1);
    await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(run(async () => "next")).resolves.toBe("next");
  });

  it("frees the slot when a task throws before it returns a promise", async () => {
    const run = createSemaphore(1);
    await expect(
      run(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    await expect(run(async () => 1)).resolves.toBe(1);
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => createSemaphore(0)).toThrow();
    expect(() => createSemaphore(-1)).toThrow();
    expect(() => createSemaphore(1.5)).toThrow();
    expect(() => createSemaphore(Number.NaN)).toThrow();
  });
});
