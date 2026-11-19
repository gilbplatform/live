import { createElement } from "react";
import type { CSSProperties, ReactElement } from "react";
import { NO_DATA_TEXT, traceAttrs } from "../trace-attrs.js";
import type { TraceFieldRef } from "../trace-attrs.js";

/** What a figure is, handed to the application when the figure is opened: the full entity address, the bare field name, the record id if known, and the displayed text. */
export interface TraceTarget { entity: string; field: string; recordId: string | null; shown: string }

/**
 * Supplied by the application: given a figure, returns the address to open for it, or nothing.
 * The kit holds no address format of its own; a different application passes a different builder.
 */
export type TraceLinkBuilder = (target: TraceTarget) => string | null | undefined;

/** What you give `TracedValue`. There is no `children`: the text shown is always `shown`, because that text is the contract value. */
export interface TracedValueProps {
  /** Where the figure comes from. Without one, the figure is not shown (see `requireSource`). */
  source: TraceFieldRef | null | undefined;
  /** The text to display. Null, undefined, empty or blank reads "no data". */
  shown: string | null | undefined;
  /** The element to draw. Default `span`; anything not in the list is drawn as `span`. */
  as?: "span" | "td" | "dd" | "strong" | "output";
  /** Builds the address to open for this figure. Supplied by the application. */
  link?: TraceLinkBuilder;
  /** Called on click with the target, before the browser follows an address. Call `preventDefault` on the event to stop the browser. */
  onOpen?: (target: TraceTarget, event: { preventDefault(): void }) => void;
  /** True when the check rejected this figure: its text is shown with no source claim and nothing to open. */
  failed?: boolean;
  /** Default true: a figure with no source reads "no data". False draws the text untraced, for words that are not figures. */
  requireSource?: boolean;
  /** The words for no data. Default "no data". */
  noDataText?: string;
  /** Hidden text read after the figure by a screen reader, for example `(Status)`. It is not part of the traced value. */
  srLabel?: string;
  /** Tooltip. A link or button defaults to `openLabel`. */
  title?: string;
  /** Words for opening the source, used as the default title and as hidden text. Default "Open the source of this figure". */
  openLabel?: string;
  className?: string;
}

const ELEMENTS: readonly string[] = ["span", "td", "dd", "strong", "output"];
const DEFAULT_OPEN_LABEL = "Open the source of this figure";

// Hidden from the eye, still read by a screen reader.
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden",
  clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0,
};

const isText = (v: unknown): v is string => typeof v === "string";
const joinClass = (...names: Array<string | undefined>): string => names.filter((n) => !!n).join(" ");

/** True for a source that names both an entity and a field. */
function hasSource(source: unknown): source is TraceFieldRef {
  if (typeof source !== "object" || source === null) return false;
  const s = source as { entityUri?: unknown; field?: unknown };
  return isText(s.entityUri) && s.entityUri.trim() !== "" && isText(s.field) && s.field.trim() !== "";
}

/**
 * True only for a string that starts like an address we are willing to open: a path, a "?" change to the current page, a fragment, or an http(s) URL.
 * Everything else is refused, whatever the builder meant: a builder's mistake must never become a script link.
 */
function isOpenableAddress(address: unknown): address is string {
  if (!isText(address)) return false;
  // Control characters are dropped by address parsers, which can turn "/\t/host" into "//host".
  if (/[\u0000-\u001f\u007f]/.test(address)) return false;
  // "//host" and "/\host" are read as another site, not a path on this one.
  if (address.startsWith("//") || address.startsWith("/\\")) return false;
  return ["/", "?", "#", "http://", "https://"].some((start) => address.startsWith(start));
}

/**
 * One figure on the page. In: where it comes from and the text to show. Out: an element carrying the three trace attributes
 * (so a check can read the source back), or the words "no data", or the failed text; a link or button when the application
 * says how to open it.
 */
export function TracedValue(props: TracedValueProps): ReactElement {
  const { source, shown, as, link, onOpen, failed, requireSource, srLabel, title, className, noDataText, openLabel: openWords } =
    props ?? ({} as TracedValueProps);
  const tag = isText(as) && ELEMENTS.includes(as) ? as : "span";
  const noData = isText(noDataText) && noDataText.trim() !== "" ? noDataText : NO_DATA_TEXT;
  const openLabel = isText(openWords) && openWords.trim() !== "" ? openWords : DEFAULT_OPEN_LABEL;

  // --- 1. Empty source ---
  // A figure with nothing to show reads "no data" and carries no source claim. It is never a zero, a guess or an old number:
  // a made-up figure that looks real is worse than an honest gap.
  if (shown === null || shown === undefined || String(shown).trim() === "") {
    return createElement(tag, { "data-trace-state": "no-data", className: joinClass("gilb-traced gilb-traced--no-data", className) }, noData);
  }
  const text = String(shown);

  // --- 2. Failed ---
  // The check rejected this figure, so it must not claim a source or offer to open one.
  if (failed === true) {
    return createElement(tag, { "data-check": "failed", className: joinClass("gilb-traced", className) }, text);
  }

  // --- 3. No source ---
  // A figure nobody can trace is not shown as a figure. Words that are not figures may opt out and are drawn untraced.
  if (!hasSource(source)) {
    if (requireSource !== false) {
      return createElement(tag, { "data-trace-state": "no-source", className: joinClass("gilb-traced gilb-traced--no-data", className) }, noData);
    }
    return createElement(tag, { "data-trace-state": "untraced", className: joinClass("gilb-traced", className) }, text);
  }

  // --- 4. Traced ---
  const attrs = traceAttrs({ ref: source, shown: text });
  const target: TraceTarget = {
    entity: source.entityUri,
    field: source.field,
    recordId: isText(source.recordId) ? source.recordId : null,
    shown: text,
  };

  // --- 5. Opening ---
  // The application builds the address. The kit has no address format of its own, so a third party passes its own builder.
  let address: string | null = null;
  if (typeof link === "function") {
    try {
      const built: unknown = link(target);
      if (isOpenableAddress(built)) address = built;
    } catch {
      // A builder that throws means no link; the figure itself still shows.
      address = null;
    }
  }
  const canOpen = typeof onOpen === "function";
  const interactive = address !== null || canOpen;

  const children: Array<string | ReactElement> = [text];
  if (isText(srLabel) && srLabel.trim() !== "") {
    children.push(createElement("span", { key: "sr", style: VISUALLY_HIDDEN }, ` ${srLabel}`));
  }
  if (interactive) {
    children.push(createElement("span", { key: "open", style: VISUALLY_HIDDEN }, ` (${openLabel})`));
  }

  const base: Record<string, unknown> = { ...attrs, className: joinClass("gilb-traced", className) };
  if (interactive) {
    base.title = isText(title) ? title : openLabel;
    if (canOpen) base.onClick = (event: { preventDefault(): void }): void => { onOpen(target, event); };
    if (address !== null) return createElement("a", { ...base, href: address }, ...children);
    return createElement("button", { ...base, type: "button" }, ...children);
  }
  if (isText(title)) base.title = title;
  return createElement(tag, base, ...children);
}
