// Smoke test of the BUILT package: run `npm run build` first. Prints PASS or FAIL.
import * as live from "../dist/index.js";

const fail = (why) => {
  console.log(`FAIL: ${why}`);
  process.exit(1);
};

for (const name of ["createLiveStore", "parseLiveNotification", "DEFAULT_HOLD_MS", "MAX_HOLD_MS", "createLiveTransport", "createCoalescer", "createLiveSession", "createStateCache", "createDotMachine", "toLiveStatusInfo", "createLiveClient", "createKitLiveSource", "buildPlanValueRow", "planValueDrawable", "traceAttrs", "scanTrace"]) {
  if (live[name] === undefined) fail(`missing export ${name}`);
}

const entity = "https://vault.example/e/A";
const store = live.createLiveStore({
  holdMs: 0,
  read: async () => ({ record: { id: 1 }, etag: "e1" }),
});
store.push({
  kind: "change",
  entity,
  typeUri: "https://vault.example/t/Value",
  etag: "e1",
  updatedAt: "2026-11-19T10:00:00.000Z",
  receivedAt: "2026-11-19T10:00:00.050Z",
  cursor: null,
});
await store.idle();
const row = store.get(entity);
store.close();
if (row?.record.id === 1) console.log("PASS");
else fail("record not stored");
