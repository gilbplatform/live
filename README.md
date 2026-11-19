# @gilbplatform/live

A small live-data store for a live dashboard on GilbPlatform: it takes server-sent events (real-time change notifications) in, re-reads the records that changed, and tells your screen once per burst. Last write wins, there is no refresh button, and it has no dependencies.

Status: version 0.1.0, the first release on npm.

## Install

`npm install @gilbplatform/live`. The React entry (`@gilbplatform/live/react`) needs react 18.2 or later; the rest needs nothing.

## Example

```ts
import { createLiveStore, parseLiveNotification } from "@gilbplatform/live";

const store = createLiveStore<MyRecord>({
  // Your normal read of one record. Return null if it no longer exists.
  read: async ({ entity }, signal) => {
    const r = await fetch(entity, { signal });
    return r.ok ? { record: await r.json(), etag: r.headers.get("etag") } : null;
  },
});

store.seed(firstFullList); // rows: { entity, typeUri, etag, record }
const stop = store.subscribe((change) => render(change.records, change.ended, change.full));

// For each server-sent event: its data line parsed as JSON, and its `id:` line as the cursor.
function onEvent(json: unknown, id: string | null) {
  const n = parseLiveNotification(json, id);
  if (n) store.push(n);
}
// Later: stop(); store.close();
```

## How it works

- The server sends notifications only: which record, which type, its etag, times and a cursor. Never the record itself. The store re-reads each changed record through your `read`, so permissions and shape are exactly those of a normal read.
- Last write wins. The etag of the re-read is the truth. A notification older than what the store holds is dropped, a duplicate etag is not read again, and an answer to an out-of-date re-read is ignored.
- Notifications are held for a short window (250 ms by default, never more than 500 ms), then released in time order and re-read together. One window gives one change to your subscribers, so a burst is one render.
- The order is by the source's own `updatedAt`, not by the cursor. The cursor is sealed and opaque: the client cannot order events or spot gaps with it. Keep `store.lastCursor()` and send it back to resume.
- An ended record leaves a small tombstone, so a late older change cannot bring it back. Tombstones are capped at 10000.

## Connect to a live stream

`createLiveTransport` opens the event stream for you, feeds the store and keeps it going. It uses only `fetch` (and the stream the response gives you), so it works in Node 22 and in browsers. It does not use the browser's built-in event-stream object, a cookie or any storage.

```ts
import { createLiveStore, createLiveTransport } from "@gilbplatform/live";

const store = createLiveStore<MyRecord>({ read: readOneRecord });

const transport = createLiveTransport({
  store,
  origin: "https://your-server.example",
  vaultId: "your-vault-id",
  types: ["Value"], // optional: only these types
  // Asked for EVERY request, with the exact URL, so a one-use proof can be fresh each time.
  // `refresh` is true once after a 401.
  auth: async (request, { refresh }) => ({ authorization: `Bearer ${await getToken(refresh)}` }),
  // Read everything again and call store.seed(...). Called when the kit cannot continue from where it left off.
  resync: async (reason) => store.seed(await readFullList()),
  onState: (state) => showState(state), // connecting, live, polling, reconnecting, resyncing, stopped
});

transport.start();
// Later: await transport.stop();
```

What it does, in plain words:

- A cut: it asks again from where it left off. The resume point goes in the address as `since=`; a half-received message is dropped and asked for again. It waits a little longer after each failure, with some randomness, and never hammers the server.
- A revoke (access taken away, or the person signed out): it stops, tells you through `onState` (`stopped`, cause `revoked`) and does not retry. A `403` stops it, and so does a second 401 in a row. A `404` on the stream makes it try the poll feed once: it polls if the feed answers, and stops (as refused) if the feed refuses too.
- A token that ends while the stream is open (`token_expired`): it reconnects quietly and asks your `auth` function for a fresh token (`refresh: true`). If the server still says 401, it stops with `unauthorized`.
- Too many streams (429, including the `anonymous` kind): it reads the change feed every 2 seconds instead and tries the stream again later, never sooner than the server's `Retry-After`.
- A client that cannot keep up (`slow_consumer`): the connection is re-opened with back-off. After three in a row it falls back to reading the feed.
- Not available here (501 `live_not_available_here`): it only polls, and does not try the stream again.
- If the server does not offer the live stream (it answers 404), the kit reads the change feed instead and checks every few seconds; the dot says so.
- An old cursor (400 `since_cursor_invalid`): it asks you, once, to read everything again (`resync("bad_cursor")`), then opens the stream from the new head. If the server refuses that too, it stops with `bad_request`.

Only one source (stream or feed) feeds the store at any moment. Credentials go in headers only, never in an address, and your `auth` function is asked for every request. Tokens and header values are never logged or put in a state or error.

`onConfirm(atMs)` is an optional callback. It is called when the server has confirmed the data is current: on every chunk of the stream (a heartbeat counts), after each change pushed, after each good feed read (even an empty one) and after `resync` resolves. It is never called on a failure.

It was tested in Node against a local test server. Browser behaviour (Safari especially) is not yet verified.

## Showing changes calmly

The store tells you about every batch it applies. If changes come in bursts, drawing each batch is tiring to look at. `createCoalescer(store, { onApply })` merges the batches of one short period (250 ms by default, at most 1000 ms) into one change, so a burst is one apply. `onApply` gets the same kind of change the store gives, and you apply it to your held list the same way.

- `pause()` stops the deliveries, so a person can read a screen that holds still. The coalescer keeps collecting. `waiting()` says how many distinct records changed meanwhile, so you can show "N changes waiting". `resume()` delivers them all as one change.
- Give it a confirmation clock (`createConfirmationClock()`) and `screenConfirmedAt()` tells you the last moment the screen was truly current. That time only moves when nothing waits: a screen that is holding changes back is not current, and does not claim to be.
- The pause control and its wording belong to your app.

## Remembering the last state

A person who comes back to a dashboard should see the last known state at once, marked as old, while the live connection catches up. `createStateCache({ store, cache, scope })` saves the store as it changes and restores it later. You supply `cache`, a small object with `load()` and `save(state)` (and, if you like, `remove()`) over your own storage. The kit never opens any storage itself.

- Use a different `scope` for each person and vault. A saved state with another scope is ignored.
- A restored state is marked stale (`isStale()`) until the server confirms it, through the confirmation clock or your own `markFresh()`. Show it as old until then.
- `restore()` returns a result. `cursor` is where the transport can start from. If `needsResync` is true, the state was saved with no safe cursor: do a full read and call `store.seed(...)` (your `resync`), and treat the rows as old until you have.
- For an app with no storage, skip it, or use `createMemoryCache()`. For a browser app, write the two methods over `localStorage` yourself. This is the app's own code, not the kit's:

```ts
const key = `live:${personId}:${vaultId}`;
const cache = {
  load: () => { const t = localStorage.getItem(key); return t === null ? null : JSON.parse(t); },
  save: (state) => { localStorage.setItem(key, JSON.stringify(state)); },
  remove: () => { localStorage.removeItem(key); },
};
const saved = createStateCache({ store, cache, scope: key });
const result = await saved.restore();
saved.attach();
```

## Hidden tabs and wall boards

A page nobody is looking at does not need an open connection. `createLiveSession` keeps one transport running while the page is shown, closes it after 60 seconds hidden (`hiddenCloseMs`), and opens a new one from where the store left off when the page is shown again. `keepLive: true` never closes it, which is what a wall board wants. You give it `createTransport`, which makes a new transport each time.

The app passes the browser's page object to `watchVisibility(session, page)`; the kit never looks for it itself. It returns a function that stops watching.

## Reading many changes at once

If a burst names many records, one request per record is slow. Give `createLiveStore` a `readBatch` next to (or instead of) `read`. It receives a list of `{ entity, typeUri }` and answers with a `Map` from entity address to the record and its etag.

- A key mapped to `null` means the record no longer exists. The store then removes it.
- A key that is absent from the map counts as a failed read, and the old row stays. An answer that left a record out proves nothing about it.
- If the whole call rejects, the store falls back to `read` for that chunk, one by one, when you gave one.
- The `hint` (the third argument) holds `sinceCursor`, which is the cursor the store held before the earliest change of the chunk. You can answer the chunk with one request to the `since=` feed using `include=body`, or with a complete copy of the changed records. Ignoring the hint is always correct.
- `readBatchSize` is the most items in one call (50 by default, never more than 200).

## When a record cannot be read yet (owed records)

A notification says that a record changed; the store then reads it. If that read fails (for example the network is cut), the stream has already moved past the notification and nothing would announce the record again. So the store keeps the record as owed.

- A failed read is retried with a back-off (about half a second at first, doubling, never more than 30 seconds). After six retries (about 31 seconds) the record is parked: it stays owed and visible, and is not hammered. A parked record is tried again on every reconnect and on every good poll tick, and when a newer change for the record arrives. `maxReadAttempts`, `owedBackoff` and `isGone` tune this.
- `client.owed()` and `store.owed()` give the count; `subscribeOwed(fn)` hears each change of the count. The dot carries it as `dot.owed`.
- The dot does not say Live while any record is owed: `showLive` is false and `cause` is `owed`. The kind stays as it was, because the connection itself is fine. `LiveDot` then shows "N changes could not be loaded yet" (change it with the `owed` label). The "Updated" time (`screenConfirmedAt`) also stands still while records are owed.
- A read that is rejected with status 403, 404 or 410 (or an error marked `gone`) means "gone for this viewer": the record is removed, as when a read finds nothing, and it is not retried. Any other failure, including 401, 429 and 5xx, is retried.
- When access is removed (the dot stops with `access_removed`, `no_access` or `signed_out`) the owed list is dropped and nothing more is read.
- The saved copy (`cache`) never skips an owed record: while any record is owed the saved state carries no cursor, so a reload does a full read.
- `tickMinIntervalMs` (default 1000) limits how often the screen-time tick (`subscribeTick`) fires. Give 0 for a tick on every confirmation.
- The owed list holds at most `maxOwed` records (a `createLiveStore` option, 50,000 by default). Recovery above that number has not been proven.

## Telling people whether the screen is current

`createDotMachine({ clock, coalescer })` answers one question: can I trust what is on the screen right now? Feed it the transport's reports (`feedTransport`, from the transport's `onState`) and the session's (`feedSession`), and read the answer with `state()` or `subscribe(fn)`. `computeDot(inputs)` is the same thing as a pure function. `toLiveStatusInfo(dot)` maps the answer onto the four plain statuses `connecting`, `live`, `offline` and `stopped`, for an app that already has such a type.

The answer has a `kind`:

| Kind | What it means | Usual plain words |
| --- | --- | --- |
| `connecting` | Not connected yet. | Connecting |
| `live` | Streaming, and the server has confirmed recently. | Live |
| `polling` | Reading the feed every few seconds, confirmed recently. | Live, checking every few seconds |
| `reconnecting` | The connection dropped; it is trying again. `retryAt` says when. | Reconnecting |
| `offline` | Trouble has lasted a minute or more. `asOf` says when the screen was last current. | Offline, showing data from 14:32 |
| `paused` | The person holds the screen still. `waiting` counts the changes held back. | Paused, 3 changes waiting |
| `hidden` | The tab is hidden, or its connection was closed on purpose. | Paused while hidden |
| `stopped` | It will not continue. `cause` says why (access removed, signed out, stopped by the app). | Stopped |

- The word Live needs a recent confirmation. `showLive` is true only when the last confirmation is recent (45 seconds on a stream, 10 seconds while polling, both adjustable), nothing is waiting, the tab is visible and the session is open. A dot that cannot say that must not say Live.
- The heartbeat watch: a stream that goes quiet for longer than the window stops counting as live, even if the connection looks open. The dot says it is reconnecting, and after the offline time (60 seconds by default) says offline.
- A quiet renewal does not flash. When the server renews the connection on a routine schedule and a recent confirmation exists, the dot stays as it was, with `quiet: true`.
- `cause` is a code (for example `no_news`, `cut`, `signed_out`, `access_removed`), never a sentence. The app writes the words, in its own language. `asOf` and `ageMs` let it say "as of 14:32".
- Call `machine.refresh()` after you pause or resume the coalescer. Call `machine.close()` when you are done.

The dot counts a connection as "heard from the server" when an event arrives, when a heartbeat arrives, when a quiet poll tick succeeds, or when a new connection opens after a healthy one (the opening line of the very first connection counts too). After a silence the new connection has to prove itself with a heartbeat or an event before the word Live comes back, so a server that accepts connections but never speaks leaves the dot on reconnecting and then offline instead of flashing Live at every reconnect. The cost is that after a silent cut the dot can stay on reconnecting for up to one heartbeat period. One limit is known: heartbeats come from the route's own timer and not from the hub, so on a quiet vault "Live" rests on the connection and its heartbeats, not on a statement by the hub that nothing was missed. A hidden tab shows as hidden and never as stopped; only a real stop (access removed, signed out, stopped by the app itself) shows as stopped.

## Putting it together

`createKitLiveSource` joins the pieces above for you: the connection, the store, the calm delivery, the saved state, the hidden-tab handling and the status. Each `subscribe` makes its own client, so two lists never share a connection. You give it your `auth`, your `read` and a `resync` that returns the full list. If you give no `createTransport`, it uses the kit's own transport.

```ts
import { createKitLiveSource } from "@gilbplatform/live";

const source = createKitLiveSource<MyRecord>({
  originOf: (vaultId) => "https://your-server.example",
  // Asked for every request; `refresh` is true once after a 401.
  auth: async (request, { refresh }) => ({ authorization: `Bearer ${await getToken(refresh)}` }),
  // Your normal read of one changed record. Return null if it is gone.
  read: async ({ entity }, signal) => {
    const r = await fetch(entity, { signal, headers: await headersFor(entity) });
    return r.ok ? { record: await r.json(), etag: r.headers.get("etag") } : null;
  },
  // The full list: called first, and again when the kit loses its place.
  resync: async (vaultId, types, reason) => {
    const rows = await readEverything(vaultId, types);
    return rows.map((r) => ({ entity: r.address, typeUri: r.type, etag: r.etag, record: r }));
  },
  pageFor: document, // optional: close the connection after a long hidden time
});

const handle = source.subscribe("your-vault-id", ["Value"], {
  onChange: (change) => render(change.records, change.ended, change.full), // the first call is the whole list
  onStatus: (info) => showStatus(info.status), // connecting, live, offline, stopped
  onTick: (at) => showAsOf(at),
});
// Later: handle.stop();
```

If you want the pieces separately (a pause control, the dot, "N changes waiting"), use `createLiveClient`, which `createKitLiveSource` is built on. It takes the same options plus `origin`, `vaultId`, `types` and `keyOf`, and gives you `subscribe`, `records()`, `dot()`, `pause()`, `resume()`, `waiting()` and `stop()`. `start()` reads the starting position, then the list, then opens the connection, in that order.

## Showing it in React

The React layer is a separate entry point, `@gilbplatform/live/react`, so the core never imports React. `react` is an optional peer dependency (version 18.2 or later): an app that does not use React does not need it.

```tsx
import { useLive, LiveDot } from "@gilbplatform/live/react";

function Board() {
  const live = useLive<MyRecord>({
    origin: "https://your-server.example",
    vaultId: "your-vault-id",
    types: ["Value"],
    auth, read, resync,
    keyOf: (r) => r.address, // the app says which address a record has
    page: document,          // hidden-tab handling
  });
  return (
    <>
      <LiveDot state={live.dot} showText />
      {live.paused && <p>{live.waiting} changes waiting</p>}
      <button onClick={live.paused ? live.resume : live.pause}>{live.paused ? "Resume" : "Pause"}</button>
      <List rows={live.records} />
    </>
  );
}
```

- `useLive` takes the client's options, plus `keyOf` (required) and `enabled` (false makes no client and no request). It returns `records`, `dot`, `waiting`, `paused`, `stale`, `asOf`, `ready`, `pause`, `resume` and `setKeepLive`.
- `LiveDot` draws the status. Its words can be replaced with the `labels` prop. The word Live appears only when the status is honestly current. The mark differs by shape as well as colour, and the words are always there for screen readers.
- The pause control is the app's. The hook only gives `pause`, `resume`, `paused` and `waiting`.
- Pass the browser's page object as `page` so a hidden tab closes its connection after a while and reopens it when shown.

## Showing a Value with its limits

A plan Value is a measure with a current figure and two limits. The bar shows all three on one line, so a reader sees at a glance where the figure stands. The kit holds no data and writes nothing: it draws what your app gives it.

The three marks, each with its plain word and the plan word behind it:

| Mark | Plain word | Plan word |
| --- | --- | --- |
| The current figure | Now | Status |
| The least that is acceptable | Minimum OK | Tolerable |
| The level aimed for | Target | Goal |

- `buildPlanValueRow(input)` makes one row from one Value: its name, its unit, which direction is better (`higher`, `lower` or `target`) and the three levels. It never throws; missing or junk parts give a row with absent marks.
- A missing limit, or a figure that failed its check, draws no bar. The part shows words instead: "no limits set", "no current value", "check failed", "cannot be drawn". A bar is never drawn from a number the kit cannot trust. `planValueDrawable(row)` is the gate that decides, and `planValueWords(row)` gives the words for a row that fails it.
- `planValueSentence(row)` gives the text twin of the bar, for example "Cost: Now 62 euro, Minimum OK 50 euro, Target 90 euro". It uses each mark's own shown text and never recomputes a number.
- The `trace` prop lets a shown figure be followed to its source (see "Letting people check a number"). The kit adds no attribute of its own when you give none.
- The app owns the pause (pass `still` to hold the bar without motion) and any wording beyond the defaults (the `labels` prop replaces each word the part adds).

For React, with a row from `buildPlanValueRow`:

```tsx
import { buildPlanValueRow } from "@gilbplatform/live";
import { PlanValueBar, PlanValueStyle } from "@gilbplatform/live/react";

const row = buildPlanValueRow({
  id: "v1", name: "Cost",
  scale: { unit: "euro", direction: "lower" },
  status: { text: "62", value: 62 }, tolerable: { text: "80", value: 80 }, goal: { text: "50", value: 50 },
});
// Once on the page: <PlanValueStyle />
const view = <PlanValueBar row={row} />; // PlanValueBullet adds the name and figures; PlanValueList takes many rows
```

For Vue, Svelte or plain pages, use only the core model: `buildPlanValueRow`, `planValueDrawable`, `planValueWords` and `planValueSentence` have no React in them. Each mark of the row carries `pos`, its place from 0 to 1 along the bar, so you can draw it your own way.

## Letting people check a number

A figure on a screen is only worth trusting if someone can follow it to where it came from. The kit lets each shown figure carry its source, and lets an app read those sources back to check them.

- `traceAttrs({ ref, shown })` gives three attributes to put on the element that shows the figure: the full address of the record (the entity), the bare slug of the field, and the text the person actually sees. Their names are in the constant `TRACE_ATTR`, the one place the kit spells them. The value is the displayed text, never the stored one, because the check compares what is on the screen.
- A figure with no source gets no attributes. `traceAttrs` returns null for it, and the part `TracedValue` shows "no data" instead of the figure. A figure with no source is never shown as if it had one.
- An empty source also shows "no data" (the words can be replaced with `noDataText`). It is never drawn as a zero or an old number, because a made-up figure that looks real is worse than an honest gap.
- `scanTrace(root)` is the reader, for an app's own check: it finds every element with any of the three attributes under `root` and sorts them into `traced` (all three present and usable) and `incomplete` (only some). A half-traced figure is a bug, so it is reported, not skipped. `readTraceAttrs(element)` reads one element.

In React, `TracedValue` writes the attributes and, when you ask, makes the figure openable:

```tsx
import { TracedValue } from "@gilbplatform/live/react";

// The app's own code: the kit holds no address format. This builder returns an address, or nothing.
const link = ({ entity, field }) => `/inspect?${new URLSearchParams({ entity, field })}`;

<TracedValue source={{ entityUri, field: "status" }} shown="62 euro" link={link} />
<TracedValue source={{ entityUri, field: "status" }} shown="62 euro" onOpen={(target) => openInPage(target)} />
```

- `link` is a function from the figure's target (entity, field, record id and displayed text) to an address to open. It must return a path, a `?` change to the current page, a `#` fragment or an `http(s)` address; anything else is refused, so a mistake in a builder cannot become a script link.
- `onOpen` is called on click with the same target, for navigation inside the page. Call `preventDefault` on the event to stop the browser following an address.
- `failed` marks a figure that the app's check rejected: its text is shown with no source claim and nothing to open.
- A screen reader hears the figure first. `srLabel` adds hidden words after it (for example "Status"), and `openLabel` the words for opening the source.

## Licence

MIT, Copyright (c) 2026 Kai Gilb. See LICENSE.

## What is not proven yet

- Real browsers, and Safari in particular.
- The stream and the change feed have not yet been run against a live production server.
- Screen readers.

## Developing

Source: github.com/gilbplatform/live.

```
npm install
npm test            # the core tests
npm run test:react  # the React tests
npm run build       # clean, then compile to dist
npm pack            # builds, checks dist and the source maps, runs a smoke test, then makes the tarball
```
