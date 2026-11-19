import { createElement, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement } from "react";
import type { DotKind, DotState } from "../state.js";
import { createDefaultLabels, defaultFormatTime } from "./labels.js";
import type { DotLabel, DotLabels } from "./labels.js";

/** What you give `LiveDot`. */
export interface LiveDotProps {
  /** The dot's state, from `useLive().dot` or from a client. */
  state: DotState;
  /** Replaces any of the words. A replaced `live` or `polling` label is still shown only when the state has a recent confirmation. */
  labels?: Partial<DotLabels>;
  /** True to hold the dot still. When absent, the reader's own motion setting decides. */
  reducedMotion?: boolean;
  /** True to show the words next to the mark. They are always present for screen readers. Default false. */
  showText?: boolean;
  /** The mark's width and height in pixels. Default 10. */
  size?: number;
  /** The clock used for the reconnect countdown. Default `Date.now`. */
  now?: () => number;
  /** Writes a time for the offline text. Default: hours and minutes in the reader's format. */
  formatTime?: (ms: number) => string;
  className?: string;
}

type Shape = "circle" | "ring" | "hollow" | "diamond" | "square" | "bars" | "dash" | "cross";

// Colour is never the only signal: every kind has its own shape, so the states stay apart without colour vision.
const SHAPES: Record<DotKind, Shape> = {
  live: "circle",
  polling: "ring",
  connecting: "hollow",
  reconnecting: "diamond",
  offline: "square",
  paused: "bars",
  hidden: "dash",
  stopped: "cross",
};

const COLOURS: Record<DotKind, string> = {
  connecting: "#6e7781",
  live: "#1a7f37",
  polling: "#1a7f37",
  reconnecting: "#bf8700",
  offline: "#cf222e",
  paused: "#0969da",
  hidden: "#6e7781",
  stopped: "#cf222e",
};

/**
 * The dot's stylesheet. It carries the reduced-motion rule too, so the setting is honoured even where the script that reads it
 * has not run (before hydration, or with scripts off).
 */
export const LIVE_DOT_CSS = [
  "@keyframes gilb-live-dot-pulse{0%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.85)}100%{opacity:1;transform:scale(1)}}",
  ".gilb-live-dot--pulse .gilb-live-dot__mark{animation:gilb-live-dot-pulse 2s ease-in-out infinite}",
  "@media (prefers-reduced-motion: reduce){.gilb-live-dot__mark{animation:none !important}}",
].join("\n");

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

type MediaListLike = {
  matches: boolean;
  addEventListener(type: "change", fn: () => void): void;
  removeEventListener(type: "change", fn: () => void): void;
};

const mediaQuery = (): MediaListLike | null => {
  const m = (globalThis as { matchMedia?: (q: string) => MediaListLike }).matchMedia;
  return typeof m === "function" ? m.call(globalThis, REDUCED_QUERY) : null;
};

function watchReduced(onChange: () => void): () => void {
  const mq = mediaQuery();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => { mq.removeEventListener("change", onChange); };
}

/**
 * Tells whether the reader asked for less motion. Out: true or false; false when the platform cannot say.
 * It follows later changes of the setting and lets go of its listener on unmount.
 */
export function useReducedMotion(): boolean {
  // useSyncExternalStore (not state set in an effect): the first render already has the right answer, so a reader who asked for
  // stillness never sees one pulsing frame, and the server render and the first client render agree (false).
  return useSyncExternalStore(watchReduced, () => mediaQuery()?.matches === true, () => false);
}

const isKind = (k: unknown): k is DotKind => typeof k === "string" && Object.prototype.hasOwnProperty.call(SHAPES, k);

function resolveLabel(label: DotLabel | undefined, fallback: DotLabel, state: DotState): string {
  for (const candidate of [label, fallback]) {
    if (candidate === undefined) continue;
    try {
      const text = typeof candidate === "function" ? candidate(state) : candidate;
      if (typeof text === "string") return text;
    } catch {
      // An app's label function that throws must not take the dot down; the default is used.
    }
  }
  return "";
}

const HIDDEN_TEXT: CSSProperties = {
  position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden",
  clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0,
};

function markStyle(kind: DotKind, shape: Shape, size: number): CSSProperties {
  const colour = `var(--gilb-live-dot-${kind}, ${COLOURS[kind]})`;
  const base: CSSProperties = {
    display: "inline-block", boxSizing: "border-box", flex: "none", width: size, height: size,
    background: colour, borderRadius: "50%",
  };
  switch (shape) {
    case "circle": return base;
    case "ring": return { ...base, boxShadow: `0 0 0 2px var(--gilb-live-dot-gap, #fff), 0 0 0 3px ${colour}` };
    case "hollow": return { ...base, background: "transparent", border: `2px solid ${colour}` };
    case "diamond": return { ...base, borderRadius: 0, transform: "rotate(45deg) scale(0.75)" };
    case "square": return { ...base, borderRadius: 0 };
    case "bars": return { ...base, borderRadius: 0, background: `linear-gradient(90deg, ${colour} 0 33%, transparent 33% 67%, ${colour} 67% 100%)` };
    case "dash": return { ...base, borderRadius: 1, height: Math.max(2, Math.round(size * 0.25)) };
    case "cross":
      return {
        ...base, background: "transparent", color: colour, borderRadius: 0, textAlign: "center",
        fontSize: Math.round(size * 1.6), lineHeight: `${size}px`, fontWeight: 700,
      };
  }
}

/**
 * The live dot: a mark, a sentence for screen readers (and for sight when `showText`), and the stylesheet.
 *
 * @param props see `LiveDotProps`
 * @returns one `span` with `role="status"`; never throws, whatever the state holds
 */
export function LiveDot(props: LiveDotProps): ReactElement {
  const state = props.state;
  const kind: DotKind = isKind(state?.kind) ? state.kind : "connecting";
  const reducedPreference = useReducedMotion();
  const reduced = props.reducedMotion ?? reducedPreference;
  const size = typeof props.size === "number" && props.size > 0 ? props.size : 10;
  const tools = { now: props.now ?? Date.now, formatTime: props.formatTime ?? defaultFormatTime };
  const defaults = createDefaultLabels(tools);

  // --- The live word is gated here ---
  // Whatever the app's label function says, "live" and "polling" are reached only through a recent confirmation
  // (`showLive`). An unconfirmed live state shows `checking`, so no label can claim a live screen that nothing confirmed.
  // Owed records come first: a screen that lacks announced records is never "live", even if a state wrongly says so.
  const owed = typeof state?.owed === "number" && state.owed > 0 ? Math.floor(state.owed) : 0;
  const confirmed = (kind === "live" || kind === "polling") && state.showLive === true && owed === 0;
  const key: keyof DotLabels = kind === "live" || kind === "polling" ? (confirmed ? kind : owed > 0 ? "owed" : "checking") : kind;
  const text = resolveLabel(props.labels?.[key], defaults[key], owed > 0 ? { ...state, owed } : state);

  // Motion only says "alive": never while paused, never unconfirmed, never against the reader's setting.
  const pulse = confirmed && !reduced;
  const shape = SHAPES[kind];
  const className = ["gilb-live-dot", pulse ? "gilb-live-dot--pulse" : "", props.className ?? ""].filter(Boolean).join(" ");

  return createElement(
    "span",
    {
      role: "status",
      "aria-live": "polite",
      className,
      "data-state": kind,
      "data-live": confirmed ? "true" : "false",
      "data-motion": pulse ? "pulse" : "still",
      ...(owed > 0 && (kind === "live" || kind === "polling") ? { "data-owed": String(owed) } : {}),
      "data-shape": shape,
      style: { display: "inline-flex", alignItems: "center", position: "relative" } satisfies CSSProperties,
    },
    createElement(
      "span",
      { className: "gilb-live-dot__mark", "aria-hidden": "true", style: markStyle(kind, shape, size) },
      shape === "cross" ? "×" : null,
    ),
    createElement(
      "span",
      { className: "gilb-live-dot__text", style: props.showText ? { marginLeft: "0.5em" } : HIDDEN_TEXT },
      text,
    ),
    // The same constant for everyone: the sheet holds no data, so it is passed as plain text, never as markup.
    createElement("style", null, LIVE_DOT_CSS),
  );
}
