/**
 * Own clips through the live path (#149): what a person's upload gets from
 * /api/label and /api/compile, through the routes themselves, on the models
 * this deployment calls (Nemotron 3.5 Super VL, Nemotron 3.5 Lightning since
 * #139). Every model call's request and raw answer is kept, so a failed
 * compile can be read, not guessed at.
 *
 * Skipped unless OWN_CLIPS is set; spends Token Factory credits.
 *
 *   OWN_CLIPS=label OWN_CLIPS_DIR=<folder of .mp4> OWN_CLIPS_RUNS=4 \
 *     node_modules/.bin/vitest run tests/bench/own-clips.test.ts
 *     label every clip RUNS times (half with the line a person might type,
 *     half with none, as the page starts), fit it as the page does, compile
 *     the fitted spec once; specs go to bench/results/own-clips-specs-<tag>.json
 *   OWN_CLIPS=compile OWN_CLIPS_TAG=after OWN_CLIPS_REPEAT=3 [OWN_CLIPS_SPECS=before] ...
 *     compile each saved spec REPEAT times: the same inputs before and after a fix
 *
 * Results: bench/results/own-clips-<phase>-<tag>.json (each request with its
 * raw answers). The clips are not in the repository: their recipes are in
 * docs/MEASUREMENTS.md section 14, and each result keeps the clip's SHA-256.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/** One model call as the route made it: what was asked, and the model's words exactly. */
type Raw = { model: string; max_tokens?: number; json_mode: boolean; thinking_off: boolean; turn: number; finish_reason?: string; prompt_tokens?: number; completion_tokens?: number; seconds: number; content: string; error?: string };
const raw = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const tf = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...tf,
    tokenFactory: (options?: Parameters<typeof tf.tokenFactory>[0]) => {
      const client = tf.tokenFactory(options);
      if (!client) return client;
      const create = client.chat.completions.create.bind(client.chat.completions);
      // every call the route makes passes through here and is kept, answered or not
      (client.chat.completions as { create: unknown }).create = async (params: Record<string, unknown>) => {
        const started = Date.now();
        const messages = params.messages as unknown[];
        const base = { model: String(params.model), max_tokens: params.max_tokens as number | undefined, json_mode: params.response_format !== undefined, thinking_off: JSON.stringify(params).includes('"enable_thinking":false'), turn: messages.length };
        try {
          const res = (await create(params as never)) as { choices: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          raw.calls.push({ ...base, finish_reason: res.choices[0]?.finish_reason, prompt_tokens: res.usage?.prompt_tokens, completion_tokens: res.usage?.completion_tokens, seconds: (Date.now() - started) / 1000, content: res.choices[0]?.message?.content ?? "" } satisfies Raw);
          return res;
        } catch (err) {
          raw.calls.push({ ...base, seconds: (Date.now() - started) / 1000, content: "", error: (err as Error).message.slice(0, 300) } satisfies Raw);
          throw err;
        }
      };
      return client;
    },
  };
});

const ROOT = process.cwd();
const PHASE = process.env.OWN_CLIPS ?? "";
const OUT = path.join(ROOT, "bench", "results");
const TAG = process.env.OWN_CLIPS_TAG ?? "before";
/** the label phase writes its fitted specs here; the compile phase reads OWN_CLIPS_SPECS (default: the "before" ones), so before and after compile the same specs */
const specsFile = (tag: string) => path.join(OUT, `own-clips-specs-${tag}.json`);

/** The line a person might type for each clip, by file name; half the runs send none, as the page starts empty. */
const HINTS: Record<string, string> = {
  "pipette-landscape-8s": "pipetting liquid into a small cartridge",
  "veggie2-portrait-8s": "pushing seed film into plant pillows",
  "foam-portrait-8s": "squeezing a drink bag so juice flows into a foam block",
  "veggie-landscape-12s": "putting seed film into plant pillows",
};

type Post = (req: Request) => Promise<Response>;
const post = async (route: Post, url: string, body: unknown) => (await route(new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).json();

/** What the page does in the browser, with ffmpeg: 480 wide, 4 fps, H.264, no sound (VIDEO_PROXY). */
function proxy(file: string): { video: string; duration_s: number } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "own-clip-"));
  try {
    const out = path.join(dir, "proxy.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-an", "-vf", "fps=4,scale=480:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
    const duration_s = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
    return { video: `data:video/mp4;base64,${readFileSync(out).toString("base64")}`, duration_s };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The calls made since `from`, and the compile's outcome in the terms the page shows. */
function outcome(r: { status: string; message?: string; warnings?: string[] }, from: number) {
  const calls = raw.calls.slice(from) as Raw[];
  if ((r.warnings ?? []).some((w) => w.startsWith("replay"))) throw new Error(`replayed, not live: ${r.warnings?.join("; ")}`);
  return { status: r.status, message: r.message, warnings: r.warnings ?? [], attempts: calls.length, first_parsed: r.status === "done" && calls.length <= 1, calls };
}

describe.runIf(PHASE !== "")("own clips, live (spends credits)", () => {
  process.loadEnvFile(process.env.UNDERSTUDY_ENV_FILE ?? ".env.local");

  it.runIf(PHASE === "label")("labels each clip, fits it, compiles it once", async () => {
    const dir = process.env.OWN_CLIPS_DIR ?? "";
    const runs = Number(process.env.OWN_CLIPS_RUNS ?? 4);
    const clips = readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort();
    expect(clips.length).toBeGreaterThan(0);
    const { POST: label } = await import("@/app/api/label/route");
    const { POST: compile } = await import("@/app/api/compile/route");
    const { fitToBench } = await import("@/lib/sim/fit");
    const { MODELS } = await import("@/lib/providers/tokenfactory");
    const results: unknown[] = [];
    const specs: unknown[] = [];
    for (const file of clips) {
      const name = file.replace(/\.mp4$/, "");
      const bytes = readFileSync(path.join(dir, file));
      const sha = createHash("sha256").update(bytes).digest("hex");
      const { video, duration_s } = proxy(path.join(dir, file));
      for (let run = 0; run < runs; run++) {
        const hint = run % 2 === 0 ? (HINTS[name] ?? "") : "";
        let from = raw.calls.length;
        const l = await post(label, "/api/label", { video, duration_s, hint, clip_sha256: sha });
        const labelled = { ...outcome(l, from), title: l.value?.title, steps: l.value?.steps?.map((s: { verb: string }) => s.verb) };
        const entry: Record<string, unknown> = { clip: name, sha256: sha, run, hint, models: { vl: MODELS.vl, nano: MODELS.nano }, label: labelled };
        if (l.status === "done") {
          const fit = fitToBench(l.value);
          const gestures = fit.spec.steps.every((s) => s.verb === "gesture");
          entry.fit = { rehearsable: fit.spec !== l.value, gestures, warnings: fit.warnings };
          from = raw.calls.length;
          const c = await post(compile, "/api/compile", { spec: fit.spec });
          entry.compile = outcome(c, from);
          specs.push({ clip: name, run, hint, spec: fit.spec, rehearsable: fit.spec !== l.value, gestures });
        }
        results.push(entry);
        const c = entry.compile as { status: string; attempts: number; message?: string } | undefined;
        console.log(`${name} #${run}${hint ? " (line)" : ""}: label ${l.status}; compile ${c ? `${c.status} in ${c.attempts} call(s)${c.message ? `: ${c.message.slice(0, 160)}` : ""}` : "-"}`);
      }
    }
    writeFileSync(path.join(OUT, `own-clips-label-${TAG}.json`), JSON.stringify({ when: new Date().toISOString(), results }, null, 1) + "\n");
    writeFileSync(specsFile(TAG), JSON.stringify({ when: new Date().toISOString(), specs }, null, 1) + "\n");
  }, 1_800_000);

  it.runIf(PHASE === "compile")("compiles each saved spec again", async () => {
    const file = specsFile(process.env.OWN_CLIPS_SPECS ?? "before");
    expect(existsSync(file)).toBe(true);
    const repeat = Number(process.env.OWN_CLIPS_REPEAT ?? 3);
    const { specs } = JSON.parse(readFileSync(file, "utf8")) as { specs: { clip: string; run: number; spec: unknown; gestures: boolean }[] };
    const { POST: compile } = await import("@/app/api/compile/route");
    const { MODELS } = await import("@/lib/providers/tokenfactory");
    const results: unknown[] = [];
    for (const s of specs.filter((x) => !x.gestures)) {
      for (let k = 0; k < repeat; k++) {
        const from = raw.calls.length;
        const c = outcome(await post(compile, "/api/compile", { spec: s.spec }), from);
        results.push({ clip: s.clip, run: s.run, k, model: MODELS.nano, compile: c });
        console.log(`${s.clip} #${s.run}.${k}: ${c.status} in ${c.attempts} call(s)${c.message ? `: ${c.message.slice(0, 160)}` : ""}`);
      }
    }
    writeFileSync(path.join(OUT, `own-clips-compile-${TAG}.json`), JSON.stringify({ when: new Date().toISOString(), model: MODELS.nano, results }, null, 1) + "\n");
  }, 3_600_000);
});
