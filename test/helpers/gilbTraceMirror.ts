// CONTRACT MIRROR, test code only. A plain copy of the application's own trace reader, fact reader and writer test double,
// taken from src/lib/live/traceAttrs.ts and src/lib/live/traceStub.ts in the GilbApp live-dashboard worktree at commit
// 3b0643ea (read 2026-11-19). The kit's writer and reader must behave exactly like these; the tests compare them.
// If the application changes its own, this copy is updated by hand and the parity tests show any drift.

/** The three attribute names, as the application spells them. */
export const TRACE_ATTR = { entity: "data-live-entity", field: "data-live-field", value: "data-live-value" } as const;

export interface MirrorSource { entity: string; field: string; value: string }
export type MirrorAttrs = Record<"data-live-entity" | "data-live-field" | "data-live-value", string>;
export interface MirrorRead { el: Element; source: MirrorSource }
export interface MirrorScan { traced: MirrorRead[]; incomplete: Element[] }

/** The shape of a field reference in the application's truth check. */
export interface MirrorFieldRef { recordId: string; entityUri: string; field: string; raw: string }
export interface MirrorFact { ref: MirrorFieldRef | null; shown: string }
/** The writer's input: the kit's reference may omit the record id and raw text. */
export interface MirrorWriterFact { ref: { entityUri: string; field: string; recordId?: string; raw?: string } | null; shown: string }

const idFromEntityUri = (u: string): string => { const i = u.lastIndexOf("/"); return i === -1 ? u : u.slice(i + 1); };

export function readTraceAttrs(el: Element): MirrorSource | null {
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

export function scanTrace(root: ParentNode): MirrorScan {
  const scan: MirrorScan = { traced: [], incomplete: [] };
  const found = root.querySelectorAll(`[${TRACE_ATTR.entity}],[${TRACE_ATTR.field}],[${TRACE_ATTR.value}]`);
  for (const el of Array.from(found)) {
    const source = readTraceAttrs(el);
    if (source) scan.traced.push({ el, source });
    else scan.incomplete.push(el);
  }
  return scan;
}

export function factsFromDom(root: ParentNode): MirrorFact[] {
  const found = root.querySelectorAll(`[${TRACE_ATTR.entity}],[${TRACE_ATTR.field}],[${TRACE_ATTR.value}]`);
  return Array.from(found).map((el): MirrorFact => {
    const source = readTraceAttrs(el);
    if (!source) return { ref: null, shown: el.textContent ?? "" };
    return {
      ref: { recordId: idFromEntityUri(source.entity), entityUri: source.entity, field: source.field, raw: source.value },
      shown: source.value,
    };
  });
}

export function traceAttrsStub(fact: MirrorWriterFact): MirrorAttrs | null {
  const ref = fact.ref;
  if (ref === null) return null;
  return {
    [TRACE_ATTR.entity]: ref.entityUri,
    [TRACE_ATTR.field]: ref.field,
    [TRACE_ATTR.value]: fact.shown,
  } as MirrorAttrs;
}
