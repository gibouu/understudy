/**
 * Apply interview or hand-edit changes to a spec by path, recording
 * provenance per leaf. Paths: `objects[<id|index>].<field>(.<sub>)*`,
 * `steps[<id|index>].<field>(.<sub>)*`, `anchor.<field>`, `title`, `summary`.
 * Inside brackets an id is matched before an index, so `[0]` means the object
 * whose id is "0" if there is one, else the first object. Provenance lands in
 * the record's `sources` under the leaf path relative to the record
 * ("tolerances.x_mm", "via_points.0.xyz_mm"); top-level fields land in the
 * spec's own `sources`.
 *
 * Changes are applied as one transaction: if the whole batch validates it is
 * accepted as is; otherwise they are applied one by one and the ones that
 * break an invariant or name an unknown field are skipped with a warning.
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

function getAt(root: unknown, tokens: string[]): unknown {
  let node = root;
  for (const t of tokens) {
    if (Array.isArray(node)) {
      const i = resolveIndex(node, t);
      if (i < 0) return undefined;
      node = node[i];
    } else if (isRec(node) && Object.hasOwn(node, t)) node = node[t];
    else return undefined;
  }
  return node;
}

/** Mutates `draft`; returns the leaf path relative to the owning record (or null when the path is bad). */
function applyOne(draft: Rec, change: SpecChange): { ok: true; record: Rec; leaf: string } | { ok: false; reason: string } {
  const tokens = parsePath(change.path);
  if (tokens.length === 0) return { ok: false, reason: "empty path" };
  if (tokens.some((t) => FORBIDDEN.has(t))) return { ok: false, reason: "forbidden path segment" };
  let node: unknown = draft;
  let record: Rec = draft;
  let recordDepth = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (Array.isArray(node)) {
      const idx = resolveIndex(node, t);
      if (idx < 0) return { ok: false, reason: "path not found" };
      node = node[idx];
      if (isRec(node) && (tokens[i - 1] === "objects" || tokens[i - 1] === "steps")) {
        record = node;
        recordDepth = i + 1;
      }
    } else if (isRec(node)) {
      if (!Object.hasOwn(node, t)) node[t] = {};
      node = node[t];
    } else return { ok: false, reason: "path not found" };
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(node)) {
    const idx = resolveIndex(node, last);
    if (idx < 0) return { ok: false, reason: "path not found" };
    node[idx] = change.value;
  } else if (isRec(node)) node[last] = change.value;
  else return { ok: false, reason: "path not found" };
  return { ok: true, record, leaf: tokens.slice(recordDepth).join(".") };
}

function recordSource(record: Rec, leaf: string, source: string) {
  const sources = isRec(record.sources) ? record.sources : (record.sources = {});
  sources[leaf] = source;
}

function validate(draft: Rec, changes: SpecChange[]): { spec: TaskSpec } | { reason: string } {
  const result = TaskSpec.safeParse(draft);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { reason: `rejected (${issue?.path.join(".") || "root"}: ${issue?.message})` };
  }
  for (const c of changes) {
    if (c.value !== undefined && getAt(result.data, parsePath(c.path)) === undefined) {
      return { reason: `${c.path}: unknown field (not part of the spec)` };
    }
  }
  return { spec: result.data };
}

export function applyChanges(spec: TaskSpec, changes: SpecChange[]): { spec: TaskSpec; warnings: string[] } {
  const warnings: string[] = [];
  // one transaction first
  const batch = structuredClone(spec) as unknown as Rec;
  let batchOk = true;
  for (const c of changes) {
    const r = applyOne(batch, c);
    if (!r.ok) {
      batchOk = false;
      break;
    }
    recordSource(r.record, r.leaf, c.source);
  }
  if (batchOk) {
    const v = validate(batch, changes);
    if ("spec" in v) return { spec: v.spec, warnings };
  }
  // fall back to one by one, skipping the offenders
  let current = structuredClone(spec);
  for (const c of changes) {
    const draft = structuredClone(current) as unknown as Rec;
    const r = applyOne(draft, c);
    if (!r.ok) {
      warnings.push(`${c.path}: ${r.reason}`);
      continue;
    }
    recordSource(r.record, r.leaf, c.source);
    const v = validate(draft, [c]);
    if ("reason" in v) {
      warnings.push(v.reason.startsWith(c.path) ? v.reason : `${c.path}: ${v.reason}`);
      continue;
    }
    current = v.spec;
  }
  return { spec: current, warnings };
}
