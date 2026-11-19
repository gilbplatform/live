import { afterEach, describe, expect, test, vi } from "vitest";
import { createConfirmationClock } from "../src/confirm.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("confirmation clock", () => {
  // Spec: Kit.Client, Clock: a confirmation says "we heard from the server just now" (LiveWire step, check 13 Honesty.Freshness)
  test("CF1 confirm, lastConfirmedAt and subscribe", () => {
    let now = 1000;
    const clock = createConfirmationClock({ now: () => now });
    const seen: number[] = [];
    const off = clock.subscribe((at) => seen.push(at));
    expect(clock.lastConfirmedAt()).toBeNull();
    clock.confirm();
    expect(clock.lastConfirmedAt()).toBe(1000);
    now = 2500;
    clock.confirm();
    clock.confirm(3000);
    expect(clock.lastConfirmedAt()).toBe(3000);
    expect(seen).toEqual([1000, 2500, 3000]);
    off();
    clock.confirm(4000);
    expect(seen).toEqual([1000, 2500, 3000]);
    expect(clock.lastConfirmedAt()).toBe(4000);
  });

  // Spec: Kit.Client, Clock: a confirmation never goes backwards (check Honesty.Freshness)
  test("CF2 never goes backwards", () => {
    const clock = createConfirmationClock({ now: () => 5000 });
    const seen: number[] = [];
    clock.subscribe((at) => seen.push(at));
    clock.confirm(5000);
    clock.confirm(4000);
    expect(clock.lastConfirmedAt()).toBe(5000);
    clock.confirm(5000);
    expect(seen).toEqual([5000, 5000]);
    expect(clock.lastConfirmedAt()).toBe(5000);
  });

  // Spec: Kit.Client, Clock: a broken subscriber harms nobody
  test("CF3 a throwing subscriber is isolated and logs only its message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = createConfirmationClock({ now: () => 10 });
    const seen: number[] = [];
    clock.subscribe(() => { throw new Error("subscriber broke"); });
    clock.subscribe((at) => seen.push(at));
    clock.confirm(10);
    expect(seen).toEqual([10]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("subscriber broke");
  });

  // Spec: Kit.Client, Clock: a time that is not a finite number is ignored
  test("CF4 a non-finite at is ignored", () => {
    const clock = createConfirmationClock({ now: () => 100 });
    const seen: number[] = [];
    clock.subscribe((at) => seen.push(at));
    clock.confirm(Number.NaN);
    clock.confirm(Infinity);
    clock.confirm("7" as unknown as number);
    expect(clock.lastConfirmedAt()).toBeNull();
    expect(seen).toEqual([]);
    clock.confirm();
    expect(clock.lastConfirmedAt()).toBe(100);
    const bad = createConfirmationClock({ now: () => Number.NaN });
    bad.confirm();
    expect(bad.lastConfirmedAt()).toBeNull();
  });
});
