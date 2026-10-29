/**
 * The spend guard in each route that calls a model (#111): live with the
 * unlock code or a sample session's token, replayed with the reason
 * otherwise, and closed in production when the code is not set. Token
 * Factory and Tavily are faked: a call that reaches them is a live one.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compiles from "@/tests/fixtures/compile.json";
import labels from "@/tests/fixtures/label.json";
import { forgetModels, MODELS, RETIRED } from "@/lib/providers/tokenfactory";
import { SAMPLES } from "@/lib/samples";
import { recordings } from "@/lib/showcase/load";
import { Program, TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";
import { forgetLiveCalls } from "@/lib/unlock/cap";
import { UNLOCK_ENV } from "@/lib/unlock/check";
import { gateNote, LIVE_CLOSED, LIVE_NEEDS_PASS, LIVE_NO_BUDGET, LIVE_RETIRED, LIVE_SPENT, LIVE_UNLISTED, UNLOCK_NEEDED } from "@/lib/unlock/messages";
import { readSampleToken, sampleToken, TOKEN_ENV } from "@/lib/unlock/token";
import { SPENT_KEY } from "@/lib/unlock/budget";
import { fakeRedis, type FakeRedis } from "@/tests/store/fake-redis";

/**
 * Token Factory stand-in: every create() is counted; the vision model answers the recorded label. It lists
 * `listed` (the four models unless a test says otherwise), or fails to list when `listFails`; `refuse`
 * answers 404 to a create() for that model, as Token Factory does for a retired one.
 */
const tf = vi.hoisted(() => ({ calls: 0, label: "", listed: [] as string[], lists: 0, listFails: false, refuse: "", models: [] as string[] }));
vi.mock("@/lib/providers/tokenfactory", async (original) => ({
  ...(await original<typeof import("@/lib/providers/tokenfactory")>()),
  wantsReplay: (req: Request) => new URL(req.url).searchParams.get("replay") === "1",
  tokenFactory: () => ({
    models: {
      list: async () => {
        tf.lists++;
        if (tf.listFails) throw new Error("connect ETIMEDOUT");
        return { data: tf.listed.map((id) => ({ id })) };
      },
    },
    chat: {
      completions: {
        create: async (params: { model: string }) => {
          if (params.model === tf.refuse) throw OpenAI.APIError.generate(404, { message: `The model \`${params.model}\` does not exist.`, code: "model_not_found" }, undefined, new Headers());
          tf.calls++;
          tf.models.push(params.model);
          return { choices: [{ message: { content: params.model.includes("VL") ? tf.label : "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
        },
      },
    },
  }),
}));

const routes = {
  label: (await import("@/app/api/label/route")).POST,
  compile: (await import("@/app/api/compile/route")).POST,
  notes: (await import("@/app/api/notes/route")).POST,
  variants: (await import("@/app/api/variants/route")).POST,
  ground: (await import("@/app/api/ground/route")).POST,
};
type Route = keyof typeof routes;

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sampleSha = sha(path.join(process.cwd(), "samples", `${SAMPLES[0].name}.mp4`));
const ownSha = "b".repeat(64);
const video = "data:video/mp4;base64,AAAA";

const recorded = compiles.at(-1)!;
const spec = TaskSpec.parse(recorded.spec);
const program = Program.parse((recorded.result as { value: unknown }).value);
const failing = program.steps.at(-1)!.step_id;
const runs = [{ world: "orbit", rollout: { pass: false, t: 1, log: [], failed_step_id: failing } }];
/** the smallest valid body each later route takes; the guard adds `unlock` or `sample_token` */
const BODIES: Record<Exclude<Route, "label">, object> = {
  compile: { spec },
  notes: { spec, program, runs, first: "orbit (0 g) FAIL", history: [] },
  variants: { spec },
  ground: { spec },
};

let tavily = 0;

async function post(route: Route, body: object, query = ""): Promise<{ status: number; json: StageResult<unknown> & { sample_token?: string }; live: boolean }> {
  const before = tf.calls + tavily;
  const res = await routes[route](new Request(`http://test/api/${route}${query}`, { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json(), live: tf.calls + tavily > before };
}

/** what the page shows: the first warning of a replay, or the reason added to a failure */
const why = (r: StageResult<unknown>) => (r.status === "done" ? r.warnings[0] : r.status === "failed" ? r.message : "");

let store: FakeRedis;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv(UNLOCK_ENV, "orbit");
  vi.stubEnv(TOKEN_ENV, "s".repeat(40));
  vi.stubEnv("TAVILY_API_KEY", "test-tavily");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      tavily++;
      return new Response("{}", { status: 503 });
    }),
  );
  // a deployment has its live budget's store (lib/unlock/budget.ts), with money left
  store = fakeRedis();
  tf.label = JSON.stringify((labels[0].result as { value: unknown }).value);
  Object.assign(tf, { listed: Object.values(MODELS), lists: 0, listFails: false, refuse: "", models: [] });
  forgetModels();
  forgetLiveCalls();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(Object.keys(BODIES) as Exclude<Route, "label">[])("the guard on /api/%s", (route) => {
  const body = BODIES[route];

  it("goes live with the unlock code", async () => {
    expect((await post(route, { ...body, unlock: "orbit" })).live).toBe(true);
  });

  it("goes live with a sample session's token", async () => {
    expect((await post(route, { ...body, sample_token: sampleToken() })).live).toBe(true);
  });

  it("with neither, replays and says why", async () => {
    const r = await post(route, body);
    expect(r.live).toBe(false);
    expect(r.status).toBe(200);
    expect(why(r.json)).toContain(LIVE_NEEDS_PASS);
  });

  it("in production without the code set, replays everything but a sample session", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv(UNLOCK_ENV, "");
    const r = await post(route, { ...body, unlock: "orbit" });
    expect(r.live).toBe(false);
    expect(why(r.json)).toContain(LIVE_CLOSED);
    expect((await post(route, { ...body, sample_token: sampleToken() })).live).toBe(true);
  });

  it("in replay, calls nothing and never reaches the guard", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv(UNLOCK_ENV, "");
    const r = await post(route, body, "?replay=1");
    expect(r.live).toBe(false);
    expect(gateNote(r.json.status === "done" ? r.json.warnings : [])).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain(LIVE_CLOSED);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("the guard on /api/label", () => {
  it("refuses a clip of your own without the code, before any call", async () => {
    const r = await post("label", { clip_sha256: ownSha, video, duration_s: 8 });
    expect(r).toMatchObject({ status: 401, live: false, json: { message: UNLOCK_NEEDED } });
  });

  it("labels a clip of your own with the code, and gives it no sample token", async () => {
    const r = await post("label", { clip_sha256: ownSha, video, duration_s: 36, unlock: "orbit" });
    expect(r).toMatchObject({ status: 200, live: true, json: { status: "done" } });
    expect(r.json.sample_token).toBeUndefined();
  });

  it("checks the request before it counts as a live call", async () => {
    const r = await post("label", { clip_sha256: sampleSha, video: "not a data uri" });
    expect(r).toMatchObject({ status: 400, live: false });
  });

  it("in production without the code set, replays a clip of your own and says why", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv(UNLOCK_ENV, "");
    const r = await post("label", { clip_sha256: ownSha, video, duration_s: 8 });
    expect(r).toMatchObject({ status: 200, live: false, json: { status: "done" } });
    expect(why(r.json)).toBe(LIVE_CLOSED);
  });
});

describe("a session that starts from a sample clip, with no code, in production", () => {
  beforeEach(() => vi.stubEnv("VERCEL_ENV", "production"));

  it.each([
    ["with the code set", "orbit"],
    ["without the code set", ""],
  ])("runs every stage live %s", async (_, code) => {
    vi.stubEnv(UNLOCK_ENV, code);
    const label = await post("label", { clip_sha256: sampleSha, video, duration_s: 36 });
    expect(label).toMatchObject({ status: 200, live: true, json: { status: "done" } });
    const token = label.json.sample_token;
    expect(readSampleToken(token)).toBe("valid");
    for (const [route, body] of Object.entries(BODIES) as [Exclude<Route, "label">, object][]) {
      expect((await post(route, { ...body, sample_token: token })).live, route).toBe(true);
    }
  });
});

describe("the live budget for judging (lib/unlock/budget.ts)", () => {
  beforeEach(() => vi.stubEnv("VERCEL_ENV", "production"));

  it("counts what each live call cost in the store", async () => {
    expect((await post("compile", { ...BODIES.compile, unlock: "orbit" })).live).toBe(true);
    expect(Number(store.data.get(SPENT_KEY))).toBeGreaterThan(0);
  });

  it("once spent, replays every route, a clip of your own and a sample session alike, and says why", async () => {
    store.data.set(SPENT_KEY, 250_000_000);
    const own = await post("label", { clip_sha256: ownSha, video, duration_s: 8, unlock: "orbit" });
    expect(own).toMatchObject({ status: 200, live: false, json: { status: "done" } });
    expect(why(own.json)).toBe(LIVE_SPENT);
    for (const [route, body] of Object.entries(BODIES) as [Exclude<Route, "label">, object][]) {
      const r = await post(route, { ...body, unlock: "orbit", sample_token: sampleToken() });
      expect(r.live, route).toBe(false);
      expect(why(r.json), route).toContain(LIVE_SPENT);
    }
  });

  it("with the store unreachable, replays a clip of your own and says why", async () => {
    store.down = true;
    const r = await post("label", { clip_sha256: ownSha, video, duration_s: 8, unlock: "orbit" });
    expect(r).toMatchObject({ status: 200, live: false, json: { status: "done" } });
    expect(why(r.json)).toBe(LIVE_NO_BUDGET);
  });

  it("answers from the recording when the store refuses a reservation after the guard let the call through", async () => {
    store.refuse = ["INCRBY"];
    for (const [route, body] of [["compile", BODIES.compile], ["variants", BODIES.variants]] as const) {
      const r = await post(route, { ...body, unlock: "orbit" });
      expect(r.live, route).toBe(false);
      expect(r.json.status, route).toBe("done");
      expect(why(r.json), route).toContain(LIVE_NO_BUDGET);
    }
  });

  it("never stops the samples' recordings, spent or unreachable", async () => {
    store.data.set(SPENT_KEY, 250_000_000);
    expect((await recordings()).length).toBeGreaterThan(0);
    expect(await post("label", { clip_sha256: sampleSha, recorded: true })).toMatchObject({ status: 200, live: false, json: { status: "done" } });
    store.down = true;
    expect((await recordings()).length).toBeGreaterThan(0);
    expect(await post("label", { clip_sha256: sampleSha, recorded: true })).toMatchObject({ status: 200, live: false, json: { status: "done" } });
  });
});

describe("the space showcase", () => {
  it("calls no model route, so the guard never touches it", () => {
    const dir = path.join(process.cwd(), "app", "space");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/\/api\//);
  });

  it("loads its recordings with the guard shut and no key", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv(UNLOCK_ENV, "");
    vi.stubEnv(TOKEN_ENV, "");
    vi.stubEnv("NEBIUS_API_KEY", "");
    expect((await recordings()).length).toBeGreaterThan(0);
  });
});

describe("models Token Factory retires on 9 Nov 2026 (#137)", () => {
  const gone = (...ids: string[]) => (tf.listed = tf.listed.filter((id) => !ids.includes(id)));

  it("calls the replacements Token Factory names, never Nano or Super", async () => {
    for (const [route, body] of Object.entries(BODIES) as [Exclude<Route, "label">, object][]) {
      expect((await post(route, { ...body, unlock: "orbit" })).live, route).toBe(true);
    }
    // the fake's "{}" changes nothing, so the patch loop is stuck at once and Ultra answers it
    expect(new Set(tf.models)).toEqual(new Set([RETIRED["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"], RETIRED["nvidia/nemotron-3-super-120b-a12b"], MODELS.ultra]));
  });

  it("replays a whole sample session when a model is gone, every stage saying why, though the pass would go live", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    gone(MODELS.nano);
    const label = await post("label", { clip_sha256: sampleSha, video, duration_s: 36 });
    expect(label).toMatchObject({ status: 200, live: false, json: { status: "done" } });
    expect(why(label.json)).toBe(LIVE_RETIRED);
    expect(label.json.sample_token).toBeUndefined();
    for (const [route, body] of Object.entries(BODIES) as [Exclude<Route, "label">, object][]) {
      const r = await post(route, { ...body, unlock: "orbit", sample_token: sampleToken() });
      expect(r.live, route).toBe(false);
      expect(why(r.json), route).toContain(LIVE_RETIRED);
    }
    expect(tf.lists).toBe(1);
  });

  it("replays a clip of your own rather than asking for a code that cannot help", async () => {
    gone(MODELS.super);
    const r = await post("label", { clip_sha256: ownSha, video, duration_s: 8 });
    expect(r).toMatchObject({ status: 200, live: false, json: { status: "done" } });
    expect(why(r.json)).toBe(LIVE_RETIRED);
  });

  it("needs Ultra too, which answers a stuck patch loop", async () => {
    gone(MODELS.ultra);
    const r = await post("compile", { ...BODIES.compile, unlock: "orbit" });
    expect(r.live).toBe(false);
    expect(why(r.json)).toContain(LIVE_RETIRED);
  });

  it("replays the step when the list cannot be read, and reads it again after 30 s", async () => {
    tf.listFails = true;
    const r = await post("compile", { ...BODIES.compile, unlock: "orbit" });
    expect(r.live).toBe(false);
    expect(why(r.json)).toContain(LIVE_UNLISTED);
    tf.listFails = false;
    await post("compile", { ...BODIES.compile, unlock: "orbit" });
    expect(tf.lists).toBe(1);
    vi.useFakeTimers({ now: Date.now() + 31_000, toFake: ["Date"] });
    try {
      expect((await post("compile", { ...BODIES.compile, unlock: "orbit" })).live).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(tf.lists).toBe(2);
  });

  it("after a 404 from a model still listed, replays from the next request on", async () => {
    tf.refuse = MODELS.nano;
    const first = await post("compile", { ...BODIES.compile, unlock: "orbit" });
    expect(first.json).toMatchObject({ status: "failed" });
    const r = await post("compile", { ...BODIES.compile, unlock: "orbit" });
    expect(r.live).toBe(false);
    expect(why(r.json)).toContain(LIVE_RETIRED);
    expect(tf.lists).toBe(2);
  });
});
