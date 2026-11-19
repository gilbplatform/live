import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeRig, startTime, stopAll } from "./helpers/clientRig.js";
import { TYPE, cur, ent } from "./helpers/liveKit.js";

beforeEach(startTime);
afterEach(async () => {
  await stopAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const saved = {
  version: 1 as const,
  scope: "s1",
  savedAt: Date.now(),
  cursor: cur(500),
  rows: [{ entity: ent("A"), typeUri: TYPE, etag: "v0", updatedAt: null, record: { entityUri: ent("A"), v: "v0" } }],
};

describe("the headless client: stale signal", () => {
  // Spec: Kit.Client, StaleSignal: subscribeStale reports a restore as true and the first full change as false; unsubscribe works (check CL18)
  test("CL18 subscribeStale reports true after a cache restore, false after the first full change, and unsubscribe works", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.lc!.inner.save({ ...saved, savedAt: Date.now() });
    const seen: boolean[] = [];
    const off = rig.client.subscribeStale((s) => seen.push(s));
    const other: boolean[] = [];
    rig.client.subscribeStale((s) => other.push(s));
    await rig.startAndSettle();
    expect(seen).toEqual([true]);
    expect(rig.client.stale()).toBe(true);
    // After unsubscribe this listener hears nothing more, while another listener still hears the change to fresh.
    off();
    // A full change from the server's side (the cursor was refused and the list was read again) makes it fresh.
    await rig.ctx().resync("bad_cursor");
    expect(rig.client.stale()).toBe(false);
    expect(other).toEqual([true, false]);
    expect(seen).toEqual([true]);
  });

  test("CL18b a listener that throws does not stop the client or the other listeners", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.lc!.inner.save({ ...saved, savedAt: Date.now() });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: boolean[] = [];
    rig.client.subscribeStale(() => { throw new Error("boom"); });
    rig.client.subscribeStale((s) => seen.push(s));
    await rig.startAndSettle();
    expect(seen).toEqual([true]);
    expect(log).toHaveBeenCalledWith("[live] a stale listener threw: boom");
  });
});
