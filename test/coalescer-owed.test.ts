import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCoalescer } from "../src/coalescer.js";
import type { Coalescer, CoalescerOptions } from "../src/coalescer.js";
import { createConfirmationClock } from "../src/confirm.js";
import type { LiveChange, RowChange } from "../src/types.js";
import { rc, row } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

// The screen time stands still while records are owed (batch L14c). The coalescer is told the count through `owed`.

function fakeSource() {
  const listeners = new Set<(c: RowChange<Rec>) => void>();
  return {
    subscribeRows(l: (c: RowChange<Rec>) => void): () => void {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    emit(c: RowChange<Rec>): void { for (const l of [...listeners]) l(c); },
  };
}

const open: Array<{ close(): void }> = [];
let applies: Array<LiveChange<Rec>> = [];
let owedNow = 0;
let ticks: number[] = [];

function mk(opts: Partial<CoalescerOptions<Rec>> = {}) {
  applies = [];
  ticks = [];
  const src = fakeSource();
  const clock = createConfirmationClock();
  const co: Coalescer<Rec> = createCoalescer<Rec>(src, {
    onApply: (c) => applies.push(c),
    intervalMs: 0,
    clock,
    owed: () => owedNow,
    onTick: (at) => ticks.push(at),
    ...opts,
  });
  open.push(co);
  return { src, clock, co };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); owedNow = 0; });
afterEach(() => {
  for (const o of open.splice(0)) o.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("coalescer: the screen time and owed reads", () => {
  // Spec: Kit.Client, Honesty: the screen is not current while a record is owed (LiveWire step, check 8 Honesty.LiveState)
  test("CO-O1 screenConfirmedAt does not advance while owed() is above 0, even when nothing is queued", () => {
    const { clock, co } = mk();
    clock.confirm(10_000);
    expect(co.screenConfirmedAt()).toBe(10_000);
    owedNow = 1;
    clock.confirm(10_500);
    clock.confirm(11_000);
    expect(co.waiting()).toBe(0);
    expect(co.screenConfirmedAt()).toBe(10_000);
    expect(ticks).toEqual([10_000]);
  });

  test("CO-O1b with owed from the start the screen time stays null", () => {
    owedNow = 2;
    const { clock, co } = mk();
    clock.confirm(10_000);
    expect(co.screenConfirmedAt()).toBeNull();
    expect(ticks).toEqual([]);
  });

  // Spec: Kit.Client, Honesty: when the owed count returns to 0 the screen time catches up, once, within the tick throttle
  test("CO-O2 after owed() returns to 0 and recheck() is called, the time advances to the latest confirmation and the tick fires once", () => {
    const { clock, co } = mk({ tickMinIntervalMs: 1000 });
    owedNow = 1;
    clock.confirm(10_000);
    clock.confirm(10_500);
    expect(co.screenConfirmedAt()).toBeNull();
    owedNow = 0;
    co.recheck();
    expect(co.screenConfirmedAt()).toBe(10_500);
    expect(ticks).toEqual([10_500]);
    // Nothing newer: a second recheck changes nothing.
    co.recheck();
    expect(ticks).toEqual([10_500]);
    expect(co.stats().ticks).toBe(1);
    // Again with a confirmation inside the throttle: the time moves, the tick waits for its allowed moment.
    owedNow = 1;
    clock.confirm(10_700);
    expect(co.screenConfirmedAt()).toBe(10_500);
    owedNow = 0;
    co.recheck();
    expect(co.screenConfirmedAt()).toBe(10_700);
    expect(ticks).toEqual([10_500]);
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([10_500, 10_700]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Spec: Kit.Client, Honesty: waiting() counts undelivered changes only, never owed reads
  test("CO-O3 waiting() is not affected by owed", () => {
    const { src, co } = mk();
    owedNow = 5;
    expect(co.waiting()).toBe(0);
    co.pause();
    src.emit(rc([row("A", "1")]));
    expect(co.waiting()).toBe(1);
    owedNow = 0;
    expect(co.waiting()).toBe(1);
    owedNow = 9;
    co.resume();
    expect(co.waiting()).toBe(0);
  });

  test("CO-O4 recheck() after close does nothing", () => {
    const { clock, co } = mk();
    owedNow = 1;
    clock.confirm(10_000);
    co.close();
    owedNow = 0;
    expect(() => co.recheck()).not.toThrow();
    expect(ticks).toEqual([]);
    expect(co.screenConfirmedAt()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
