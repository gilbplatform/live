import { describe, expect, test } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  RETRY_AFTER_DEFAULT_MS,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
  clampRetryHintMs,
  nextBackoffMs,
  retryAfterMs,
} from "../src/backoff.js";

describe("backoff", () => {
  // Spec: Kit.Client, Transport: reconnect delays grow and are capped (LiveWire step, check Resilience.Backoff)
  test("B1 exact delays at the two random extremes", () => {
    expect([BACKOFF_BASE_MS, BACKOFF_CAP_MS]).toEqual([1000, 30000]);
    const o = { baseMs: 1000, capMs: 30000 };
    const att = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(att.map((a) => nextBackoffMs(a, o, () => 0))).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(att.map((a) => nextBackoffMs(a, o, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  // Spec: Kit.Client, Transport: never above the cap, never below half (check Resilience.Backoff)
  test("B2 bounds over random draws", () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 1000; i++) {
      const attempt = 1 + Math.floor(rnd() * 12);
      const d = Math.min(30000, 1000 * 2 ** (attempt - 1));
      const v = nextBackoffMs(attempt, { baseMs: 1000, capMs: 30000 }, rnd);
      expect(v).toBeLessThanOrEqual(30000);
      expect(v).toBeGreaterThanOrEqual(Math.floor(d / 2));
      expect(v).toBeLessThanOrEqual(d);
    }
    // A huge attempt number does not overflow past the cap.
    expect(nextBackoffMs(5000, { baseMs: 1000, capMs: 30000 }, () => 1)).toBe(30000);
    // The random part is really used: two draws give two values.
    expect(nextBackoffMs(4, {}, () => 0.2)).not.toBe(nextBackoffMs(4, {}, () => 0.9));
    // A random() outside 0..1 is clamped.
    expect(nextBackoffMs(2, { baseMs: 1000, capMs: 30000 }, () => 5)).toBe(2000);
    expect(nextBackoffMs(2, { baseMs: 1000, capMs: 30000 }, () => -5)).toBe(1000);
    expect(nextBackoffMs(2, { baseMs: 1000, capMs: 30000 }, () => NaN)).toBeGreaterThanOrEqual(1000);
  });

  // Spec: Kit.Client, Transport: odd input falls back to sane defaults (check Resilience.Backoff)
  test("B3 odd inputs", () => {
    expect(nextBackoffMs(1, {}, () => 1)).toBe(1000);
    for (const a of [0, -3, NaN, -Infinity]) expect(nextBackoffMs(a, {}, () => 1), String(a)).toBe(1000);
    expect(nextBackoffMs(Infinity, {}, () => 1)).toBeLessThanOrEqual(30000);
    expect(nextBackoffMs(Infinity, {}, () => 1)).toBeGreaterThan(0);
    expect(nextBackoffMs(1, { baseMs: NaN, capMs: -1 }, () => 1)).toBe(1000);
    expect(nextBackoffMs(1, { baseMs: 0, capMs: Infinity }, () => 1)).toBe(1000);
    expect(nextBackoffMs(3, { baseMs: 20, capMs: 80 }, () => 1)).toBe(80);
    expect(nextBackoffMs(1, { baseMs: 20, capMs: 80 }, () => 0)).toBe(10);
  });

  // Spec: Kit.Client, Transport: Retry-After is whole seconds, clamped (check Resilience.RetryAfter)
  test("B4 retryAfterMs", () => {
    expect([RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS, RETRY_AFTER_DEFAULT_MS]).toEqual([1000, 300000, 5000]);
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs("0")).toBe(1000);
    expect(retryAfterMs("999999")).toBe(300000);
    expect(retryAfterMs("301")).toBe(300000);
    expect(retryAfterMs("300")).toBe(300000);
    expect(retryAfterMs("299")).toBe(299000);
    for (const bad of ["1.5", "-1", "Wed, 21 Oct 2026 07:28:00 GMT", "", "abc", "1234567", " 7", "7 "]) {
      expect(retryAfterMs(bad), JSON.stringify(bad)).toBe(5000);
    }
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs(undefined)).toBe(5000);
    expect(retryAfterMs("2", { minMs: 3000, maxMs: 4000, defaultMs: 9 })).toBe(3000);
    expect(retryAfterMs("x", { defaultMs: 9 })).toBe(9);
  });

  // Spec: Kit.Client, Transport: the server's retry hint is clamped (check Resilience.Backoff)
  test("B5 clampRetryHintMs", () => {
    expect(clampRetryHintMs(0)).toBe(250);
    expect(clampRetryHintMs(3000)).toBe(3000);
    expect(clampRetryHintMs(10 ** 9)).toBe(60000);
    expect(clampRetryHintMs(250)).toBe(250);
    expect(clampRetryHintMs(60000)).toBe(60000);
  });
});
