# Changelog

## 0.1.0

The first release. It holds a live store (server-sent change notifications in, re-read records out, last write wins), a transport that opens the event stream and falls back to the change feed, a client that ties them together with a saved state, the status dot that only says Live when it has recent proof, and a React layer (`@gilbplatform/live/react`) with `useLive` and `LiveDot`. It has no dependencies; React is an optional peer.
