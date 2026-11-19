// Trace attributes: every figure a dashboard shows can carry three attributes that say which record, which field and what
// text it displays. A check can then read them back from the page and compare, so a number changed on screen is caught.
// This file is pure: it names no page and no UI library, and uses only the element types for its reader.

// --- Contract ---

// The attribute names are spelled here and nowhere else. A writer and a reader that each spelled them would drift apart
// without any test noticing; one constant makes the pair a single contract.
/** The three attribute names. The one place they are spelled. */
export const TRACE_ATTR = { entity: "data-live-entity", field: "data-live-field", value: "data-live-value" } as const;

/** The words shown in place of a figure that has no data. Never a zero and never an old number. */
export const NO_DATA_TEXT = "no data";

/** Where a figure comes from: the full entity address, the bare stored field name, and optionally the record id and its stored text. */
export interface TraceFieldRef { entityUri: string; field: string; recordId?: string; raw?: string }

/** One shown figure: its source (null when it has none) and the text the person sees. */
export interface TraceFact { ref: TraceFieldRef | null; shown: string }

/** What the reader finds on the page: the full entity address, the bare field name, and the displayed text. */
export interface TraceSource { entity: string; field: string; value: string }

/** The attributes a writer puts on an element, keyed by attribute name. */
export type TraceAttrs = Record<(typeof TRACE_ATTR)[keyof typeof TRACE_ATTR], string>;

/** A fully traced element and the source it declares. */
export interface TraceRead { el: Element; source: TraceSource }

/** Every element with any trace attribute, in page order: those that read fully, and those that carry only part. */
export interface TraceScan { traced: TraceRead[]; incomplete: Element[] }

// --- Writer ---

/**
 * The attributes for one shown fact, or null when the fact has no source (a figure with no source gets none).
 * In: a fact. Out: the three attributes, or null.
 */
export function traceAttrs(fact: TraceFact): TraceAttrs | null {
  const ref = fact?.ref;
  if (ref === null || ref === undefined) return null;
  // The strings are written as given and not checked here. A bad entity or field then reaches the reader, which reports
  // the element as incomplete: a loud failure on the page beats a silent repair that hides a broken source.
  // The value is the text the person sees, never the stored text: the check compares what is on screen.
  return {
    [TRACE_ATTR.entity]: ref.entityUri,
    [TRACE_ATTR.field]: ref.field,
    [TRACE_ATTR.value]: fact.shown,
  } as TraceAttrs;
}

// --- Reader ---

/**
 * Reads the three attributes off one element. In: an element. Out: the source only when entity and field are present and
 * not blank, and the value is present (an empty value is allowed); anything else is null. Never throws.
 */
export function readTraceAttrs(el: Element): TraceSource | null {
  try {
    const entity = el.getAttribute(TRACE_ATTR.entity);
    const field = el.getAttribute(TRACE_ATTR.field);
    const value = el.getAttribute(TRACE_ATTR.value);
    if (entity === null || field === null || value === null) return null;
    if (entity.trim() === "" || field.trim() === "") return null;
    return { entity, field, value };
  } catch {
    return null;
  }
}

const ANY_TRACE_ATTR = `[${TRACE_ATTR.entity}],[${TRACE_ATTR.field}],[${TRACE_ATTR.value}]`;

/**
 * Finds every element under a root that has any trace attribute, and sorts each into `traced` or `incomplete`, keeping
 * page order. In: a root. Out: the two lists.
 */
export function scanTrace(root: ParentNode): TraceScan {
  const scan: TraceScan = { traced: [], incomplete: [] };
  // An element with only some of the attributes is a half-traced figure. It is a bug the check must report, so it is
  // collected into `incomplete` and not skipped.
  for (const el of Array.from(root.querySelectorAll(ANY_TRACE_ATTR))) {
    const source = readTraceAttrs(el);
    if (source) scan.traced.push({ el, source });
    else scan.incomplete.push(el);
  }
  return scan;
}
