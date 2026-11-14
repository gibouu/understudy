// What a page loads before anyone touches it (#229): the packages below are hundreds of kilobytes each and serve
// one click (an uploaded clip, the export download), so the pages must reach them only through import().
// Follows every static, non-type import from each page's entry modules, as the bundler does.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const HEAVY = ["mediabunny", "hyparquet-writer", "fflate", "@mediapipe/tasks-vision", "three", "@mujoco/mujoco"];
const PAGES: Record<string, string[]> = {
  "/": ["app/page.tsx", "app/layout.tsx"],
  "/try": ["app/try/page.tsx"],
  "/demo": ["app/demo/page.tsx"],
  "/space": ["app/space/page.tsx"],
  "/space/[clip]": ["app/space/[clip]/page.tsx"],
};

/** `import x from "m"` and `export ... from "m"`, leaving out `import type` / `export type` (erased) */
const STATIC = /^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  return [`${base}.ts`, `${base}.tsx`, base, path.join(base, "index.ts")].find((f) => existsSync(f) && statSync(f).isFile()) ?? null;
}

/** the packages a page reaches statically, each with the chain of files that brings it in */
function packagesOf(entries: string[]): Map<string, string[]> {
  const seen = new Set<string>();
  const found = new Map<string, string[]>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(STATIC)) {
      const local = resolve(file, spec);
      if (local) walk(local, [...chain, path.relative(ROOT, local)]);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!found.has(pkg)) found.set(pkg, chain);
      }
    }
  };
  for (const e of entries) walk(path.join(ROOT, e), [e]);
  return found;
}

describe("first load of each page", () => {
  for (const [page, entries] of Object.entries(PAGES)) {
    it(`${page} reaches no heavy package without import()`, () => {
      const reached = packagesOf(entries);
      const heavy = HEAVY.filter((p) => reached.has(p)).map((p) => `${p} via ${reached.get(p)!.join(" -> ")}`);
      expect(heavy).toEqual([]);
    });
  }

  it("sees through to a package (the walk itself works)", () => {
    expect(packagesOf(["lib/export/zip.ts"]).has("fflate")).toBe(true);
    expect(packagesOf(["lib/sim/render.ts"]).has("three")).toBe(true);
  });
});
