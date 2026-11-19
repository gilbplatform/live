// A contract mirror, not shipped. These are the pure row functions of GilbApp's value strip, copied as plain TypeScript
// from src/lib/live/valueStrip.ts at GilbApp commit 59ab2523 (markOf, place, noteOf, rowOf). Only the input type changed:
// it is the local MirrorReadValue below instead of the app's ReadValue. The kit's buildPlanValueRow must give the same rows.

export type MirrorRef = { entityUri: string; field: string; recordId?: string; raw?: string };
export type MirrorLevel = { text: string | null; value: number | null; qualified: boolean; ref: MirrorRef | null };
export type MirrorReadValue = {
  id: string;
  entityUri: string;
  tag: string | null;
  scale: { unit: string; direction: "lower" | "higher" | "target"; ref: MirrorRef | null } | null;
  status: MirrorLevel | null;
  tolerable: MirrorLevel | null;
  goal: MirrorLevel | null;
};

export type MirrorMark = {
  label: "Now" | "Minimum OK" | "Target"; term: "Status" | "Tolerable" | "Goal"; present: boolean; text: string;
  value: number | null; qualified: boolean; ref: MirrorRef | null; pos: number | null;
};
export type MirrorRow = {
  id: string; entityUri: string; name: string; unit: string; unitRef: MirrorRef | null;
  direction: "lower" | "higher" | "target"; flipped: boolean;
  now: MirrorMark; minimumOk: MirrorMark; target: MirrorMark;
  drawable: boolean; note: string;
};

export const MIRROR_NOT_SET_TEXT = "not set";
export const MIRROR_NO_LIMITS_TEXT = "no limits set";
export const MIRROR_LIMITS_ORDER_TEXT = "limits out of order";
export const MIRROR_UNNAMED_TEXT = "Unnamed value";

export function markOf(level: MirrorLevel | null, label: MirrorMark["label"], term: MirrorMark["term"]): MirrorMark {
  if (level && level.text !== null) {
    return { label, term, present: true, text: level.text, value: level.value, qualified: level.qualified, ref: level.ref, pos: null };
  }
  return { label, term, present: false, text: MIRROR_NOT_SET_TEXT, value: null, qualified: false, ref: null, pos: null };
}

export function place(marks: MirrorMark[], flipped: boolean): void {
  const values = marks.map((m) => m.value as number);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  for (const m of marks) {
    const norm = lo === hi ? 0.5 : ((m.value as number) - lo) / (hi - lo);
    m.pos = flipped ? 1 - norm : norm;
  }
}

export function noteOf(direction: MirrorRow["direction"], tolerable: MirrorMark, goal: MirrorMark): string {
  if (!tolerable.present || !goal.present) return MIRROR_NO_LIMITS_TEXT;
  if (tolerable.value !== null && goal.value !== null) {
    if (direction === "higher" && goal.value < tolerable.value) return MIRROR_LIMITS_ORDER_TEXT;
    if (direction === "lower" && goal.value > tolerable.value) return MIRROR_LIMITS_ORDER_TEXT;
  }
  return "";
}

export function rowOf(v: MirrorReadValue): MirrorRow {
  const name = (v.tag ?? "").trim();
  const direction = v.scale?.direction ?? "higher";
  const flipped = direction === "lower";
  const now = markOf(v.status, "Now", "Status");
  const minimumOk = markOf(v.tolerable, "Minimum OK", "Tolerable");
  const target = markOf(v.goal, "Target", "Goal");
  const marks = [now, minimumOk, target];
  const drawable = marks.every((m) => m.present && m.value !== null);
  if (drawable) place(marks, flipped);
  return {
    id: v.id, entityUri: v.entityUri,
    name: name === "" ? MIRROR_UNNAMED_TEXT : name,
    unit: v.scale?.unit ?? "",
    unitRef: v.scale?.ref ?? null,
    direction, flipped,
    now, minimumOk, target,
    drawable,
    note: noteOf(direction, minimumOk, target),
  };
}
