// The screen parts for one plan Value drawn as a bullet bar, and a list of them. createElement only, no markup language.
// The part trusts nothing but the model's gate: a bar is drawn only from a row that passes it, otherwise words are shown.
import { createElement, Fragment, useMemo } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  CANNOT_DRAW_TEXT, CHECK_FAILED_TEXT, LIMITS_ORDER_TEXT, NOT_SET_TEXT, NO_STATUS_TEXT,
  planValueDrawable, planValueSentence, planValueWords,
} from "../plan-value-model.js";
import type { PlanFieldRef, PlanValueRowLike } from "../plan-value-model.js";
import { useReducedMotion } from "./live-dot.js";

/** The words this part adds itself. Each can be replaced; the rest of the words come from the row. */
export type PlanValueLabels = {
  noStatus: string; cannotDraw: string; unitNotSet: string;
  termStatus: string; termTolerable: string; termGoal: string; empty: string;
};

const DEFAULT_LABELS: PlanValueLabels = {
  noStatus: NO_STATUS_TEXT, cannotDraw: CANNOT_DRAW_TEXT, unitNotSet: NOT_SET_TEXT,
  termStatus: "Status", termTolerable: "Tolerable", termGoal: "Goal", empty: "No Values in this plan yet.",
};

/**
 * Writes the attributes that let a shown figure be followed to its source. In: the figure's source and its shown text.
 * Out: the attributes to put on the element, or null. The application passes it; this part has no idea who checks the figures.
 */
export type PlanValueTrace = (fact: { ref: PlanFieldRef | null; shown: string }) => Record<string, string> | null;

/** The props every part takes. */
type CommonProps = {
  /** The row to show. A row from buildPlanValueRow, or any object with at least those fields. */
  row: PlanValueRowLike;
  /** The application's attribute writer for shown figures. Without it the part adds no attribute of its own. */
  trace?: PlanValueTrace;
  /** Replaces any of the words the part adds. */
  labels?: Partial<PlanValueLabels>;
  /** Forces the answer to "less motion"; otherwise the reader's own setting is used. */
  reducedMotion?: boolean;
  /** True when the application paused its updating: no motion at all. */
  still?: boolean;
  /** An extra class name for the outer element. */
  className?: string;
};

/** Props of the bar alone. */
export type PlanValueBarProps = CommonProps & {
  /**
   * Set by a part that already shows the failed figure's own words next to the bar (the bullet does):
   * the bar then keeps its marker but does not say "check failed" a second time.
   */
  failedShownElsewhere?: boolean;
};
/** Props of the bar with its name, unit and figures. */
export type PlanValueBulletProps = CommonProps;
/** Props of a list of bullets. */
export type PlanValueListProps = Omit<CommonProps, "row"> & { rows: readonly PlanValueRowLike[] };

// --- The style sheet ---

// A constant, so that no input can reach it. The reduced-motion rule is repeated here for readers who set it,
// besides the hook, because a style sheet answers before any script runs.
export const PLAN_VALUE_CSS = [
  ".gilb-plan-value-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}",
  ".gilb-plan-value{display:grid;gap:4px}",
  ".gilb-plan-value__name{font-weight:600}",
  ".gilb-plan-value__marks{display:flex;flex-wrap:wrap;gap:4px 16px}",
  ".gilb-plan-value__note{margin:0;font-size:.875em}",
  ".gilb-plan-value-bar{display:block;width:100%;min-width:120px;color:var(--gilb-plan-value-ink, #1f2933)}",
  ".gilb-plan-value-bar__svg{display:block;width:100%;height:14px;overflow:visible}",
  ".gilb-plan-value-bar [data-band=\"near\"],.gilb-plan-value-bar [data-band=\"far\"]{stroke:none}",
  ".gilb-plan-value-bar pattern *{stroke:var(--gilb-plan-value-pattern, #7b8794);fill:var(--gilb-plan-value-pattern, #7b8794)}",
  ".gilb-plan-value-bar [data-mark=\"now\"]{fill:var(--gilb-plan-value-now, #2f6f9f)}",
  ".gilb-plan-value-bar [data-mark=\"minimum-ok\"]{stroke:var(--gilb-plan-value-limit, #52606d)}",
  ".gilb-plan-value-bar [data-mark=\"target\"]{stroke:var(--gilb-plan-value-target, #102a43)}",
  ".gilb-plan-value-bar[data-motion=\"grow\"] [data-mark=\"now\"]{transition: width 240ms ease-out}",
  ".gilb-plan-value-bar__words{font-size:.875em}",
  "@media (prefers-reduced-motion: reduce){.gilb-plan-value-bar [data-mark=\"now\"]{transition: none !important}}",
].join("\n");

/** The style sheet as an element. One per list; the single parts do not render it. */
export function PlanValueStyle(): ReactElement {
  return createElement("style", null, PLAN_VALUE_CSS);
}

// --- Small helpers ---

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

const HIDDEN: CSSProperties = {
  position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden",
  clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0,
};

// Only plain data and aria attributes pass: a writer can never add an event handler or a link through this door.
const SAFE_ATTR = /^(data|aria)-[a-z0-9-]+$/;

function traceFor(trace: PlanValueTrace | undefined, ref: PlanFieldRef | null, shown: string): Record<string, string> {
  // An absent, empty or failed figure has nothing to follow, so the writer is not even asked.
  if (typeof trace !== "function" || shown === "" || shown === CHECK_FAILED_TEXT || shown === NOT_SET_TEXT) return {};
  try {
    const got = trace({ ref, shown });
    const out: Record<string, string> = {};
    if (isRecord(got)) for (const [k, v] of Object.entries(got)) if (SAFE_ATTR.test(k) && typeof v === "string") out[k] = v;
    return out;
  } catch {
    // A writer that throws must not take the figure down.
    return {};
  }
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ");
}

function labelsOf(l: Partial<PlanValueLabels> | undefined): PlanValueLabels {
  const out: PlanValueLabels = { ...DEFAULT_LABELS };
  if (isRecord(l)) for (const k of Object.keys(DEFAULT_LABELS) as Array<keyof PlanValueLabels>) if (typeof l[k] === "string") out[k] = l[k] as string;
  return out;
}

// The ids of the patterns must differ between two bars on one page; a short hash keeps two ids that look alike
// once made safe (like "a b" and "a_b") apart.
function patternIds(rowId: string): { hatch: string; dots: string } {
  let h = 2166136261;
  for (let i = 0; i < rowId.length; i++) { h ^= rowId.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const base = `gpv-${rowId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}-${h.toString(36)}`;
  return { hatch: `${base}-h`, dots: `${base}-d` };
}

// --- The bar ---

/**
 * One Value as a bar: up to Now, a dashed mark at Minimum OK, a heavy mark at Target. In: a row and the common props.
 * Out: the picture with a text alternative when the row passes the gate, otherwise only words (no picture at all).
 * Never throws on junk props.
 */
export function PlanValueBar(props: PlanValueBarProps): ReactElement {
  const row = (isRecord(props?.row) ? props.row : {}) as PlanValueRowLike;
  const labels = labelsOf(props?.labels);
  const preference = useReducedMotion();
  const reduced = props?.reducedMotion ?? preference;
  const ids = useMemo(() => patternIds(typeof row.id === "string" ? row.id : ""), [row.id]);

  // --- The gate ---
  // The row's own drawable flag and note are not trusted: the gate checks the marks again.
  const drawable = planValueDrawable(row);
  const grow = drawable && props?.still !== true && !reduced;
  const shell = {
    className: joinClass("gilb-plan-value-bar", props?.className),
    "data-drawable": drawable ? "true" : "false",
    "data-motion": grow ? "grow" : "still",
  };

  if (!drawable) {
    // The words are the fallback and the text twin of the picture: a bar that cannot be trusted is never drawn.
    const words = planValueWords(row);
    const repeated = words.kind === "check_failed" && props?.failedShownElsewhere === true;
    const text = repeated ? "" : words.kind === "no_status" ? labels.noStatus : words.kind === "cannot_draw" ? labels.cannotDraw : words.text;
    return createElement("span", shell, createElement("span", { className: "gilb-plan-value-bar__words", "data-words": words.kind }, text));
  }

  // --- Places on the bar ---
  const nowPos = row.now.pos as number;
  const minPos = row.minimumOk.pos as number;
  const targetPos = row.target.pos as number;
  const near = Math.min(minPos, targetPos);
  const far = Math.max(minPos, targetPos);

  // Marks differ by dash and weight as well as colour: colour alone is not a signal.
  const svg = createElement(
    "svg",
    {
      role: "img", "aria-label": planValueSentence(row), focusable: "false",
      viewBox: "0 0 100 12", preserveAspectRatio: "none", className: "gilb-plan-value-bar__svg", overflow: "visible",
    },
    createElement(
      "defs", null,
      createElement("pattern", { id: ids.hatch, patternUnits: "userSpaceOnUse", width: 3, height: 3, patternTransform: "rotate(45)" },
        createElement("line", { x1: 0, y1: 0, x2: 0, y2: 3, stroke: "currentColor", strokeWidth: 0.7 })),
      createElement("pattern", { id: ids.dots, patternUnits: "userSpaceOnUse", width: 4, height: 4 },
        createElement("circle", { cx: 2, cy: 2, r: 0.6, fill: "currentColor" })),
    ),
    createElement("rect", { "data-band": "near", x: 0, y: 0, width: near * 100, height: 12, fill: `url(#${ids.hatch})` }),
    createElement("rect", { "data-band": "between", x: near * 100, y: 0, width: (far - near) * 100, height: 12, fill: "currentColor", fillOpacity: 0.06 }),
    createElement("rect", { "data-band": "far", x: far * 100, y: 0, width: (1 - far) * 100, height: 12, fill: `url(#${ids.dots})` }),
    createElement("rect", {
      "data-mark": "now", x: 0, y: 3.5, width: nowPos * 100, height: 5, fill: "currentColor",
      ...(grow ? { style: { transition: "width 240ms ease-out" } } : {}),
    }),
    createElement("line", {
      "data-mark": "minimum-ok", x1: minPos * 100, x2: minPos * 100, y1: 0, y2: 12,
      stroke: "currentColor", strokeWidth: 1.4, strokeDasharray: "2 1.5", vectorEffect: "non-scaling-stroke",
    }),
    createElement("line", {
      "data-mark": "target", x1: targetPos * 100, x2: targetPos * 100, y1: 0, y2: 12,
      stroke: "currentColor", strokeWidth: 2.6, vectorEffect: "non-scaling-stroke",
    }),
  );
  const note = row.note === LIMITS_ORDER_TEXT ? createElement("span", { className: "gilb-plan-value-bar__note" }, row.note) : null;
  return createElement("span", shell, svg, note);
}

// --- The bullet ---

const MARKS = [
  { slot: "now", label: "Now", term: "Status", key: "termStatus" },
  { slot: "minimumOk", label: "Minimum OK", term: "Tolerable", key: "termTolerable" },
  { slot: "target", label: "Target", term: "Goal", key: "termGoal" },
] as const;

/**
 * One Value as a row: its name, its unit, the bar, and the three figures with their plain words. In: a row and the common props.
 * Out: a labelled group. The figures are the texts the row holds, never a number worked out here. Never throws on junk props.
 */
export function PlanValueBullet(props: PlanValueBulletProps): ReactElement {
  const row = (isRecord(props?.row) ? props.row : {}) as PlanValueRowLike;
  const labels = labelsOf(props?.labels);
  const trace = props?.trace;
  const name = typeof row.name === "string" ? row.name : "";
  const unit = typeof row.unit === "string" ? row.unit : "";
  const drawable = planValueDrawable(row);

  // --- The unit ---
  const unitFailed = unit === CHECK_FAILED_TEXT;
  const unitEl = createElement(
    "span",
    {
      className: "gilb-plan-value__unit",
      ...(unitFailed ? { "data-check": "failed" } : {}),
      ...traceFor(trace, isRecord(row.unitRef) ? (row.unitRef as PlanFieldRef) : null, unit),
    },
    unit === "" ? labels.unitNotSet : unit,
  );

  // --- The three figures ---
  const marks = MARKS.map((def) => {
    const raw = (row as unknown as Record<string, unknown>)[def.slot];
    const mark = isRecord(raw) ? raw : {};
    const present = mark.present === true;
    const text = present && typeof mark.text === "string" ? mark.text : NOT_SET_TEXT;
    const failed = text === CHECK_FAILED_TEXT;
    const word = labels[def.key];
    return createElement(
      "span",
      { key: def.term, className: "gilb-plan-value__mark", "data-term": def.term, title: word, ...(failed ? { "data-check": "failed" } : {}) },
      createElement("span", { className: "gilb-plan-value__label" }, def.label),
      " ",
      createElement(
        "span",
        { className: "gilb-plan-value__figure", ...(present ? traceFor(trace, isRecord(mark.ref) ? (mark.ref as PlanFieldRef) : null, text) : {}) },
        text,
      ),
      createElement("span", { className: "gilb-plan-value__hidden", style: HIDDEN }, ` (${word})`),
    );
  });

  // --- The note ---
  // Every word is read once. A drawn bar shows its own out-of-order note, so the paragraph stays out of it;
  // a bar that shows words already says why, so the paragraph adds only a row note that says something else.
  const words = planValueWords(row);
  const barWords = words.kind === "no_status" ? labels.noStatus : words.kind === "cannot_draw" ? labels.cannotDraw : words.text;
  const rowNote = typeof row.note === "string" ? row.note : "";
  const noteText = drawable || rowNote === "" || rowNote === barWords ? "" : rowNote;

  return createElement(
    "div",
    {
      role: "group", "aria-label": name, className: joinClass("gilb-plan-value", props?.className),
      "data-row": typeof row.id === "string" ? row.id : "", "data-drawable": drawable ? "true" : "false",
    },
    createElement("span", { className: "gilb-plan-value__name" }, name),
    unitEl,
    createElement(PlanValueBar, { row, failedShownElsewhere: true, labels: props?.labels, reducedMotion: props?.reducedMotion, still: props?.still }),
    createElement("span", { className: "gilb-plan-value__marks" }, ...marks),
    noteText === "" ? null : createElement("p", { className: "gilb-plan-value__note" }, noteText),
  );
}

// --- The list ---

/**
 * Many Values as a list, in the order given (never sorted or dropped), with one style sheet for the whole list.
 * An empty list shows one line of words. Never throws on junk props.
 */
export function PlanValueList(props: PlanValueListProps): ReactElement {
  const labels = labelsOf(props?.labels);
  const rows: readonly PlanValueRowLike[] = Array.isArray(props?.rows) ? props.rows : [];
  if (rows.length === 0) return createElement(Fragment, null, createElement(PlanValueStyle), createElement("p", { className: "gilb-plan-value-list__empty" }, labels.empty));
  const items: ReactNode[] = rows.map((row, i) =>
    createElement(
      "li", { key: isRecord(row) && typeof row.id === "string" && row.id !== "" ? row.id : `row-${i}` },
      createElement(PlanValueBullet, { row, trace: props.trace, labels: props.labels, reducedMotion: props.reducedMotion, still: props.still }),
    ));
  return createElement(
    Fragment, null,
    createElement(PlanValueStyle),
    createElement("ul", { className: joinClass("gilb-plan-value-list", props.className), role: "list" }, ...items),
  );
}
