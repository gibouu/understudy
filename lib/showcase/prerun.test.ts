/**
 * The samples' similar tasks, run ahead of time, checked and made.
 *
 * Without PRERUN_RECORD (CI, `pnpm test`): every public/showcase/<clip>.variants.json
 * parses, is for the spec its clip's recording ends its interview on (the one
 * /try hands the similar-tasks section), and has one program for each similar
 * task, written for that task's spec (a gesture clip may have none: its
 * reply says why). No network.
 *
 * With PRERUN_RECORD the live path runs once per named clip and rewrites its
 * .variants.json. It spends Token Factory credits, a few tenths of a cent per clip:
 *
 *   PRERUN_RECORD=iss-veggie-seed-film,iss-wave UNDERSTUDY_ENV_FILE=.env.local \
 *     node_modules/.bin/vitest run lib/showcase/prerun.test.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Checked } from "@/lib/variants/validate";
import { same } from "./play";
import { baseOf } from "./prerun";
import { Session, VariantsRecording } from "./session";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "public", "showcase");
const RECORD = (process.env.PRERUN_RECORD ?? "").split(",").filter(Boolean);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".variants.json")) : [];
const session = (name: string) => Session.parse(JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")));

describe.runIf(RECORD.length > 0)("pre-run the similar tasks (live, spends credits)", () => {
  it.each(RECORD)(
    "%s",
    async (name) => {
      process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");
      if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from the env file");
      const { prerunClip } = await import("./prerun");
      const rec = await prerunClip(ROOT, session(name), (l) => console.log(l));
      writeFileSync(path.join(DIR, `${name}.variants.json`), `${JSON.stringify(rec, null, 2)}\n`);
    },
    300_000,
  );
});

describe.runIf(RECORD.length === 0)("pre-run similar tasks", () => {
  it.each(files.length ? files : ["(none)"])("%s", (f) => {
    if (f === "(none)") return;
    const rec = VariantsRecording.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8")));
    expect(f).toBe(`${rec.clip.name}.variants.json`);
    const s = session(rec.clip.name);
    expect(rec.clip.sha256).toBe(s.clip.sha256);
    expect(same(rec.spec, baseOf(s).spec)).toBe(true);
    const offered = (rec.suggestions.value as Checked).variants;
    expect(rec.programs.map((p) => p.id)).toEqual(offered.map((v) => v.id));
    for (const p of rec.programs) expect(same(p.spec, offered.find((v) => v.id === p.id)!.spec)).toBe(true);
  });
});

describe.runIf(RECORD.length === 0 && files.length > 0)("the routes answer a pre-run with no model", () => {
  const post = (handler: (r: Request) => Promise<Response>, route: string, body: unknown) =>
    handler(new Request(`http://localhost${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).then((r) => r.json());

  it.each(files)("%s", async (f) => {
    const rec = VariantsRecording.parse(JSON.parse(readFileSync(path.join(DIR, f), "utf8")));
    const { POST: variants } = await import("@/app/api/variants/route");
    const { POST: compile } = await import("@/app/api/compile/route");
    const r = await post(variants, "/api/variants", { spec: rec.spec, first: 1 });
    expect(r.status).toBe("done");
    expect(same(r.value, rec.suggestions.value)).toBe(true);
    expect(r.warnings[0]).toMatch(/^replay: recorded on .*, ahead of time for this sample$/);
    // "Suggest more" is not pre-run: it never gets the same five again
    const more = await post(variants, "/api/variants?replay=1", { spec: rec.spec, first: 6 });
    expect(more.warnings?.[0] ?? "").not.toMatch(/ahead of time/);
    for (const p of rec.programs) {
      const c = await post(compile, "/api/compile", { spec: p.spec });
      expect(c.status).toBe("done");
      expect(same(c.value, p.result.value)).toBe(true);
    }
  });
});
