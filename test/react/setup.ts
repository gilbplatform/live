// Gives the React tests a page. The page is made here, not by the source under test: the kit's React files never name it.
import { afterEach } from "vitest";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window;
const globals: Record<string, unknown> = {
  window: w,
  document: w.document,
  navigator: w.navigator,
  HTMLElement: w.HTMLElement,
  Node: w.Node,
  MutationObserver: w.MutationObserver,
  getComputedStyle: w.getComputedStyle.bind(w),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  // Newer Node versions define some of these (navigator) as read-only getters; define over them.
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// The testing library reads the page when it loads, so it is loaded only now.
const { cleanup } = await import("@testing-library/react");
afterEach(() => { cleanup(); });
