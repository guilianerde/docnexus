import { expect, it } from "vitest";
import { mapWithConcurrency } from "../src/concurrency.js";

it("bounds active work and preserves input order despite reversed completion", async () => {
  const gate = Promise.withResolvers<void>();
  let active = 0, peak = 0;
  const completed: number[] = [];
  const items = Array.from({ length: 60 }, (_, index) => index);
  const result = await mapWithConcurrency(items, 24, async index => {
    peak = Math.max(peak, ++active);
    if (index === 0) await gate.promise;
    else {
      await Promise.resolve();
      if (index === 59) gate.resolve();
    }
    active--;
    completed.push(index);
    return index;
  });
  expect(peak).toBe(24);
  expect(completed.at(-1)).toBe(0);
  expect(result).toEqual(items);
});

it("stops scheduling on error, drains started work and reports the first input failure", async () => {
  const gate = Promise.withResolvers<void>();
  const earlier = new Error("earlier input"), later = new Error("later input");
  const started: number[] = [];
  let settled = false;
  const pending = mapWithConcurrency([0, 1, 2], 2, async index => {
    started.push(index);
    if (index === 0) { await gate.promise; throw earlier; }
    throw later;
  }).catch(error => { settled = true; return error; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(started).toEqual([0, 1]);
  expect(settled).toBe(false);
  gate.resolve();
  expect(await pending).toBe(earlier);
});

it("handles empty and serial workloads", async () => {
  expect(await mapWithConcurrency([], 24, async value => value)).toEqual([]);
  expect(await mapWithConcurrency([1, 2], 1, async value => value * 2)).toEqual([2, 4]);
});
