// The model of one plan Value drawn as a bullet bar: a Now, a Minimum OK and a Target on one scale.
// Pure: no screen library, no browser object, no import. Any developer can use it with any screen layer.
// The rules repeat those of the app's own value strip on purpose: a developer without the app's readers needs the same honest rows.

/** Which way is better on the scale: "lower" is flipped so that better always points right. */
export type PlanDirection = "lower" | "higher" | "target";
/** The plain word each mark is shown under. */
export type PlanMarkLabel = "Now" | "Minimum OK" | "Target";
/** The Planguage term each mark is read from. */
export type PlanMarkTerm = "Status" | "Tolerable" | "Goal";

/** Where a shown figure comes from, so an application can follow it back to its record. The kit only carries it. */
export type PlanFieldRef = { entityUri: string; field: string; recordId?: string; raw?: string };

/** One level of a Value as an application reads it: the text to show, the number behind it, and where it came from. */
export type PlanLevelInput = { text: string | null; value: number | null; qualified?: boolean; ref?: PlanFieldRef | null };

/** What goes into buildPlanValueRow: one Value with its Scale and its three levels. Every part may be missing. */
export type PlanValueInput = {
  id: string;
  name?: string | null;
  entityUri?: string;
  scale?: { unit?: string; direction?: PlanDirection; ref?: PlanFieldRef | null } | null;
  status?: PlanLevelInput | null;
  tolerable?: PlanLevelInput | null;
  goal?: PlanLevelInput | null;
};

/** One mark on a row: its words, the text that is shown, the number behind it, and its place (0 to 1) along the bar. */
export type PlanMarkLike = {
  label: PlanMarkLabel; term: PlanMarkTerm; present: boolean; text: string;
  value: number | null; pos: number | null; qualified?: boolean; ref?: PlanFieldRef | null;
};

/**
 * What the screen part takes. A row object an application already holds with at least these fields
 * (for example the app's own strip row) is accepted as it is, with no mapping.
 */
export type PlanValueRowLike = {
  id: string; name: string; unit: string; direction: PlanDirection; flipped: boolean;
  now: PlanMarkLike; minimumOk: PlanMarkLike; target: PlanMarkLike;
  drawable: boolean; note: string; entityUri?: string; unitRef?: PlanFieldRef | null;
};

/** The same row with the source fields all present: what buildPlanValueRow gives back. */
export type PlanValueRow = Omit<PlanValueRowLike, "now" | "minimumOk" | "target" | "entityUri" | "unitRef"> & {
  now: PlanValueMark; minimumOk: PlanValueMark; target: PlanValueMark;
  entityUri: string; unitRef: PlanFieldRef | null;
};
/** A mark of a built row, with its flags and its source always present. */
export type PlanValueMark = PlanMarkLike & { qualified: boolean; ref: PlanFieldRef | null };

/** Shown in place of a figure that is not there. Never "0": an absent figure is not a zero. */
export const NOT_SET_TEXT = "not set";
/** The note when the Minimum OK or the Target is missing. */
export const NO_LIMITS_TEXT = "no limits set";
/** The note when both limits are numbers but the Target is on the wrong side of the Minimum OK. */
export const LIMITS_ORDER_TEXT = "limits out of order";
/** The name of a Value that has none. A name is never made up from the id. */
export const UNNAMED_TEXT = "Unnamed value";
/** What a figure reads when it failed its check. The application sets it; the kit only recognises it. */
export const CHECK_FAILED_TEXT = "check failed";
/** The words when there is no Now. */
export const NO_STATUS_TEXT = "no current value";
/** The words when every figure is there but the row still cannot be trusted as a picture. */
export const CANNOT_DRAW_TEXT = "cannot be drawn";

// --- Reading junk safely ---

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

// A number that is not finite would give a NaN position that draws nothing and says nothing,
// so such a figure counts as absent-valued; its text may still be shown.
const finiteOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

const isDirection = (x: unknown): x is PlanDirection => x === "lower" || x === "higher" || x === "target";

function markOf(level: unknown, label: PlanMarkLabel, term: PlanMarkTerm): PlanValueMark {
  if (isRecord(level) && typeof level.text === "string") {
    return {
      label, term, present: true, text: level.text, value: finiteOrNull(level.value), pos: null,
      qualified: level.qualified === true, ref: isRecord(level.ref) ? (level.ref as PlanFieldRef) : null,
    };
  }
  return { label, term, present: false, text: NOT_SET_TEXT, value: null, pos: null, qualified: false, ref: null };
}

// The position comes from the three marks of this one Value only: the bar is a picture of this Value, not of the plan.
function place(marks: PlanValueMark[], flipped: boolean): void {
  const values = marks.map((m) => m.value as number);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  for (const m of marks) {
    // Equal numbers would divide by zero; they sit in the middle instead.
    const norm = lo === hi ? 0.5 : ((m.value as number) - lo) / (hi - lo);
    m.pos = flipped ? 1 - norm : norm;
  }
}

function noteOf(direction: PlanDirection, tolerable: PlanValueMark, goal: PlanValueMark): string {
  if (!tolerable.present || !goal.present) return NO_LIMITS_TEXT;
  if (tolerable.value !== null && goal.value !== null) {
    if (direction === "higher" && goal.value < tolerable.value) return LIMITS_ORDER_TEXT;
    if (direction === "lower" && goal.value > tolerable.value) return LIMITS_ORDER_TEXT;
  }
  return "";
}

/**
 * Builds one bullet row from one Value. In: the Value with its Scale and levels (any part may be missing or junk).
 * Out: a row with all three marks, a drawable flag, the position of each mark when drawable, and a note.
 * Never throws: junk gives a row with absent marks.
 */
export function buildPlanValueRow(input: PlanValueInput): PlanValueRow {
  const v: Record<string, unknown> = isRecord(input) ? input : {};
  const scale = isRecord(v.scale) ? v.scale : null;
  const name = (typeof v.name === "string" ? v.name : "").trim();
  const direction: PlanDirection = isDirection(scale?.direction) ? scale.direction : "higher";
  const flipped = direction === "lower";
  const now = markOf(v.status, "Now", "Status");
  const minimumOk = markOf(v.tolerable, "Minimum OK", "Tolerable");
  const target = markOf(v.goal, "Target", "Goal");
  const marks = [now, minimumOk, target];
  const drawable = marks.every((m) => m.present && m.value !== null);
  if (drawable) place(marks, flipped);
  return {
    id: typeof v.id === "string" ? v.id : "",
    entityUri: typeof v.entityUri === "string" ? v.entityUri : "",
    name: name === "" ? UNNAMED_TEXT : name,
    unit: typeof scale?.unit === "string" ? scale.unit : "",
    unitRef: isRecord(scale?.ref) ? (scale.ref as PlanFieldRef) : null,
    direction, flipped,
    now, minimumOk, target,
    drawable,
    note: noteOf(direction, minimumOk, target),
  };
}

// --- The gate ---

type MaybeMark = Record<string, unknown> | null;
const marksOf = (row: unknown): [MaybeMark, MaybeMark, MaybeMark] => {
  const r = isRecord(row) ? row : {};
  const pick = (m: unknown): MaybeMark => (isRecord(m) ? m : null);
  return [pick(r.now), pick(r.minimumOk), pick(r.target)];
};

/**
 * The gate that decides whether a bar may be drawn. In: any row. Out: true only when the row says it is drawable,
 * no mark failed its check, and every mark is present with a finite value and a position inside 0 to 1.
 * The row's own flag and note are not trusted alone: a mark that failed its check, or a position that is not usable,
 * must not become a bar. Never throws.
 */
export function planValueDrawable(row: PlanValueRowLike): boolean {
  if (!isRecord(row) || row.drawable !== true) return false;
  return marksOf(row).every((m) =>
    m !== null && m.text !== CHECK_FAILED_TEXT && m.present === true
    && typeof m.value === "number" && Number.isFinite(m.value)
    && typeof m.pos === "number" && Number.isFinite(m.pos) && m.pos >= 0 && m.pos <= 1);
}

/** What the part shows in place of, or beside, the bar. */
export type PlanValueWordsResult = { kind: "bar" | "check_failed" | "no_limits" | "no_status" | "cannot_draw"; text: string };

/**
 * The words for a row. In: any row. Out: the kind and the text. A drawable row is "bar" with its note (which may be empty).
 * Otherwise the first that applies: a failed check, a missing limit, a missing Now, and last "cannot be drawn".
 * The bar and the words are separate so that the words are the fallback and the text twin of the picture.
 * Never throws.
 */
export function planValueWords(row: PlanValueRowLike): PlanValueWordsResult {
  if (planValueDrawable(row)) return { kind: "bar", text: typeof row.note === "string" ? row.note : "" };
  const [now, minimumOk, target] = marksOf(row);
  if ([now, minimumOk, target].some((m) => m !== null && m.text === CHECK_FAILED_TEXT)) return { kind: "check_failed", text: CHECK_FAILED_TEXT };
  if (minimumOk?.present !== true || target?.present !== true) return { kind: "no_limits", text: NO_LIMITS_TEXT };
  if (now?.present !== true) return { kind: "no_status", text: NO_STATUS_TEXT };
  return { kind: "cannot_draw", text: CANNOT_DRAW_TEXT };
}

/**
 * The text alternative of the bar, for example "Cost: Now 62 euro, Minimum OK 50 euro, Target 90 euro".
 * In: any row and an optional number formatter. Out: one sentence built from each mark's shown text, never a recomputed number;
 * the formatter is used only for a mark that has no text. Adds "Limits out of order." when the row's note says so. Never throws.
 */
export function planValueSentence(row: PlanValueRowLike, format?: (n: number) => string): string {
  const r: Record<string, unknown> = isRecord(row) ? row : {};
  const unit = typeof r.unit === "string" && r.unit !== "" ? ` ${r.unit}` : "";
  const shown = (m: Record<string, unknown> | null): string => {
    if (m === null) return NOT_SET_TEXT;
    if (typeof m.text === "string" && m.text !== "") return m.text;
    if (typeof m.value === "number" && Number.isFinite(m.value) && format) {
      try { return format(m.value); } catch { /* a formatter that throws falls back to the plain words */ }
    }
    return NOT_SET_TEXT;
  };
  const [now, minimumOk, target] = marksOf(row);
  const name = typeof r.name === "string" ? r.name : "";
  const body = `Now ${shown(now)}${unit}, Minimum OK ${shown(minimumOk)}${unit}, Target ${shown(target)}${unit}`;
  const head = name === "" ? body : `${name}: ${body}`;
  return r.note === LIMITS_ORDER_TEXT ? `${head}. Limits out of order.` : head;
}
