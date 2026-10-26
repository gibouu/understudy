/**
 * Apply interview or hand-edit changes to a spec by path, recording
 * provenance per leaf. Paths: `objects[<id|index>].<field>(.<sub>)*`,
 * `steps[<id|index>].<field>(.<sub>)*`, `anchor.<field>`, `title`, `summary`.
 * Inside brackets an id is matched before an index, so `[0]` means the object
 * whose id is "0" if there is one, else the first object. Provenance lands in
 * the record's `sources` under the leaf path relative to the record
 * ("tolerances.x_mm", "via_points.0.xyz_mm"); replacing a parent drops the
 * provenance of its descendants; top-level fields land in the spec's own
 * `sources`.
 *
 * A batch is one transaction: either every change applies and the result
 * validates, or nothing is applied and the warnings name each change that
 * fails on its own (or the batch as a whole when only the combination does).
 * Reference consistency (ids, frames) is `validateSpec`'s job, run by the
 * caller after a successful apply.
 */
import { TaskSpec, type SpecChange } from "./schema";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** `objects[rack].size_mm` -> ["objects", "rack", "size_mm"] */
export function parsePath(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(/[^.[\]]+|\[([^\]]+)\]/g)) out.push(m[1] ?? m[0]);
  return out;
}

function resolveIndex(list: unknown[], token: string): number {
  const byId = list.findIndex((item) => isRec(item) && item.id === token);
  if (byId >= 0) return byId;
  const asIndex = Number(token);
  if (/^\d+$/.test(token) && asIndex < list.length) return asIndex;
  return -1;
}

/** The value at a spec path (ids or indexes in brackets), or undefined when the path does not resolve. */
/** A slot that starts with a bare object or step id (`rack.size_mm`, as Nano sometimes writes it) in the canonical form. */
export function canonicalSlot(spec: TaskSpec, slot: string): string {
  const [head, ...rest] = parsePath(slot);
  if (rest.length === 0 || head === "objects" || head === "steps") return slot;
  const list = spec.objects.some((o) => o.id === head) ? "objects" : spec.steps.some((s) => s.id === head) ? "steps" : null;
  return list ? `${list}[${head}].${rest.join(".")}` : slot;
}

export function valueAt(spec: TaskSpec, path: string): unknown {
  let node: unknown = spec;
  for (const t of parsePath(path)) {
    if (Array.isArray(node)) node = node[resolveIndex(node, t)];
    else if (isRec(node) && Object.hasOwn(node, t)) node = node[t];
    else return undefined;
  }
  return node;
}

/** Follow a path of resolved tokens (array positions are numeric strings). */
function getResolved(root: unknown, resolved: string[]): unknown {
  let node = root;
  for (const t of resolved) {
    if (Array.isArray(node)) node = node[Number(t)];
    else if (isRec(node) && Object.hasOwn(node, t)) node = node[t];
    else return undefined;
  }
  return node;
}

/** Keys the caller supplied that the validated result does not have (the schema stripped them). */
function missingKeys(supplied: unknown, parsed: unknown, prefix: string, out: string[]) {
  if (isRec(supplied)) {
    if (!isRec(parsed)) {
      out.push(prefix);
      return;
    }
    for (const k of Object.keys(supplied)) {
      if (!Object.hasOwn(parsed, k)) out.push(prefix ? `${prefix}.${k}` : k);
      else missingKeys(supplied[k], parsed[k], prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (Array.isArray(supplied) && Array.isArray(parsed)) {
    supplied.forEach((v, i) => missingKeys(v, parsed[i], `${prefix}.${i}`, out));
  }
}

type Applied = { change: SpecChange; resolved: string[] };

/** Mutates `draft`. Returns the resolved location, or a reason. */
function applyOne(draft: Rec, change: SpecChange): { ok: true; resolved: string[] } | { ok: false; reason: string } {
  const tokens = parsePath(change.path);
  if (tokens.length === 0) return { ok: false, reason: "empty path" };
  if (tokens.some((t) => FORBIDDEN.has(t))) return { ok: false, reason: "forbidden path segment" };
  const resolved: string[] = [];
  let node: unknown = draft;
  let record: Rec = draft;
  let recordDepth = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (Array.isArray(node)) {
      const idx = resolveIndex(node, t);
      if (idx < 0) return { ok: false, reason: "path not found" };
      resolved.push(String(idx));
      node = node[idx];
      if (isRec(node) && (tokens[i - 1] === "objects" || tokens[i - 1] === "steps")) {
        record = node;
        recordDepth = i + 1;
      }
    } else if (isRec(node)) {
      if (!Object.hasOwn(node, t)) node[t] = {};
      resolved.push(t);
      node = node[t];
    } else return { ok: false, reason: "path not found" };
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(node)) {
    const idx = resolveIndex(node, last);
    if (idx < 0) return { ok: false, reason: "path not found" };
    resolved.push(String(idx));
    node[idx] = structuredClone(change.value); // never alias the caller's objects
  } else if (isRec(node)) {
    resolved.push(last);
    node[last] = structuredClone(change.value);
  } else return { ok: false, reason: "path not found" };

  const leaf = tokens.slice(recordDepth).join(".");
  const sources = isRec(record.sources) ? record.sources : (record.sources = {});
  for (const k of Object.keys(sources)) if (k.startsWith(`${leaf}.`)) delete sources[k]; // a parent replaced
  sources[leaf] = change.source;
  return { ok: true, resolved };
}

function tryBatch(spec: TaskSpec, changes: SpecChange[]): { spec: TaskSpec } | { reason: string } {
  const draft = structuredClone(spec) as unknown as Rec;
  const applied: Applied[] = [];
  for (const change of changes) {
    const r = applyOne(draft, change);
    if (!r.ok) return { reason: `${change.path}: ${r.reason}` };
    applied.push({ change, resolved: r.resolved });
  }
  const result = TaskSpec.safeParse(draft);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { reason: `rejected (${issue?.path.join(".") || "root"}: ${issue?.message})` };
  }
  for (const { change, resolved } of applied) {
    const got = getResolved(result.data, resolved);
    if (change.value !== undefined && got === undefined) return { reason: `${change.path}: unknown field (not part of the spec)` };
    const missing: string[] = [];
    missingKeys(change.value, got, "", missing);
    if (missing.length) return { reason: `${change.path}: unknown field(s) ${missing.join(", ")}` };
  }
  return { spec: result.data };
}

export function applyChanges(spec: TaskSpec, changes: SpecChange[]): { spec: TaskSpec; warnings: string[] } {
  if (changes.length === 0) return { spec: structuredClone(spec), warnings: [] };
  const whole = tryBatch(spec, changes);
  if ("spec" in whole) return { spec: whole.spec, warnings: [] };
  const warnings = [`no change applied: ${whole.reason}`];
  // Blame: a change whose removal makes the batch valid is at fault.
  const offenders: string[] = [];
  if (changes.length > 1) {
    changes.forEach((c, i) => {
      if ("spec" in tryBatch(spec, changes.filter((_, j) => j !== i))) offenders.push(`${c.path}: the batch is valid without it`);
    });
  }
  // Otherwise name every change that fails on its own; if none does, the combination is at fault.
  if (offenders.length === 0) {
    for (const c of changes) {
      const alone = tryBatch(spec, [c]);
      if ("reason" in alone) offenders.push(alone.reason.startsWith(c.path) ? alone.reason : `${c.path}: ${alone.reason}`);
    }
  }
  if (offenders.length === 0) offenders.push("the changes conflict with each other");
  return { spec: structuredClone(spec), warnings: [...warnings, ...offenders] };
}
