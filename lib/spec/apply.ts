/**
 * Apply interview or hand-edit changes to a spec by path, recording
 * provenance per field. Paths: `objects[<id|index>].<field>(.<sub>)*`,
 * `steps[<id|index>].<field>(.<sub>)*`, `anchor.<field>`, `title`, `summary`.
 * A change that makes the spec invalid is skipped with a warning.
 */
import { TaskSpec, type SpecChange } from "./schema";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** `objects[rack].size_mm` -> ["objects", "rack", "size_mm"] */
export function parsePath(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(/[^.[\]]+|\[([^\]]+)\]/g)) out.push(m[1] ?? m[0]);
  return out;
}

function resolveIndex(list: unknown[], token: string): number {
  const asIndex = Number(token);
  if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < list.length) return asIndex;
  return list.findIndex((item) => isRec(item) && item.id === token);
}

export function applyChanges(spec: TaskSpec, changes: SpecChange[]): { spec: TaskSpec; warnings: string[] } {
  const warnings: string[] = [];
  let current: TaskSpec = structuredClone(spec);
  for (const change of changes) {
    const tokens = parsePath(change.path);
    if (tokens.length === 0) {
      warnings.push(`empty path`);
      continue;
    }
    const draft = structuredClone(current) as unknown as Rec;
    let node: unknown = draft;
    let record: Rec | null = null; // the object or step whose provenance we record
    let fieldOnRecord: string | null = null;
    let ok = true;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i];
      if (Array.isArray(node)) {
        const idx = resolveIndex(node, t);
        if (idx < 0) {
          ok = false;
          break;
        }
        node = node[idx];
        if (isRec(node) && (tokens[i - 1] === "objects" || tokens[i - 1] === "steps")) {
          record = node;
          fieldOnRecord = tokens[i + 1] ?? null;
        }
      } else if (isRec(node)) {
        if (!(t in node)) node[t] = {};
        node = node[t];
      } else {
        ok = false;
        break;
      }
    }
    const last = tokens[tokens.length - 1];
    if (!ok || (!isRec(node) && !Array.isArray(node))) {
      warnings.push(`${change.path}: path not found`);
      continue;
    }
    if (Array.isArray(node)) {
      const idx = resolveIndex(node, last);
      if (idx < 0) {
        warnings.push(`${change.path}: path not found`);
        continue;
      }
      node[idx] = change.value;
    } else {
      node[last] = change.value;
    }
    if (record && fieldOnRecord) {
      const sources = isRec(record.sources) ? record.sources : (record.sources = {});
      sources[fieldOnRecord] = change.source;
    }
    const result = TaskSpec.safeParse(draft);
    if (!result.success) {
      const issue = result.error.issues[0];
      warnings.push(`${change.path}: rejected (${issue?.path.join(".") || "root"}: ${issue?.message})`);
      continue;
    }
    current = result.data;
  }
  return { spec: current, warnings };
}
