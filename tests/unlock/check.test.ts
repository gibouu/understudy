import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLES } from "@/lib/samples";
import { done, failed } from "@/lib/spec/stage-result";
import { forgetLiveCalls, LIVE_PER_MINUTE, takeLiveCall } from "@/lib/unlock/cap";
import { explain, liveGate, UNLOCK_ENV } from "@/lib/unlock/check";
import { gateNote, isUnlockRefusal, LIVE_BUSY, LIVE_CLOSED, LIVE_EXPIRED, LIVE_NEEDS_PASS, LIVE_NO_SECRET, LIVE_WRONG_CODE, UNLOCK_NEEDED, UNLOCK_WRONG } from "@/lib/unlock/messages";
import { fakeRedis } from "@/tests/store/fake-redis";
import { readSampleToken, SAMPLE_TOKEN_TTL_S, sampleToken, TOKEN_ENV } from "@/lib/unlock/token";

const sampleSha = createHash("sha256")
  .update(readFileSync(path.join(process.cwd(), "samples", `${SAMPLES[0].name}.mp4`)))
  .digest("hex");
const ownSha = "a".repeat(64);
const SECRET = "s".repeat(40);

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv(UNLOCK_ENV, "");
  vi.stubEnv(TOKEN_ENV, SECRET);
  forgetLiveCalls();
  // a deployment has its live budget's store (lib/unlock/budget.ts), with money left
  fakeRedis();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the sample token", () => {
  it("is good for an hour, then expires", () => {
    const now = Date.UTC(2026, 9, 26, 12);
    const token = sampleToken(now)!;
    expect(readSampleToken(token, now)).toBe("valid");
    expect(readSampleToken(token, now + (SAMPLE_TOKEN_TTL_S - 1) * 1000)).toBe("valid");
    expect(readSampleToken(token, now + SAMPLE_TOKEN_TTL_S * 1000)).toBe("expired");
  });

  it("cannot be stretched, forged or carried to another secret", () => {
    const token = sampleToken()!;
    const [exp, mac] = token.split(".");
    expect(readSampleToken(`${Number(exp) + 86_400}.${mac}`)).toBe("invalid");
    expect(readSampleToken(`${exp}.${"A".repeat(43)}`)).toBe("invalid");
    expect(readSampleToken(`${exp}.${mac}x`)).toBe("invalid");
    expect(readSampleToken({ token })).toBe("none");
    expect(readSampleToken("")).toBe("none");
    vi.stubEnv(TOKEN_ENV, "t".repeat(40));
    expect(readSampleToken(token)).toBe("invalid");
  });

  it("is not made or accepted without a secret, nor with a short one", () => {
    const token = sampleToken()!;
    for (const secret of ["", "short secret"]) {
      vi.stubEnv(TOKEN_ENV, secret);
      expect(sampleToken()).toBeUndefined();
      expect(readSampleToken(token)).toBe("invalid");
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("shorter than 32"));
  });
});

describe("the gate on /api/label", () => {
  it("lets every clip through when the code is not set outside production, and logs it", async () => {
    expect(await liveGate("label", { clip_sha256: ownSha })).toEqual({ live: true, sample: false });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(`${UNLOCK_ENV} is not set`));
  });

  it("lets a sample through without a code, marked as one", async () => {
    vi.stubEnv(UNLOCK_ENV, "orbit");
    expect(await liveGate("label", { clip_sha256: sampleSha })).toEqual({ live: true, sample: true });
  });

  it("asks for the code for any other clip, and refuses a wrong one", async () => {
    vi.stubEnv(UNLOCK_ENV, "orbit");
    expect(await liveGate("label", { clip_sha256: ownSha })).toMatchObject({ live: false, refusal: { status: 401, message: UNLOCK_NEEDED } });
    expect(await liveGate("label", { unlock: "  " })).toMatchObject({ live: false, refusal: { status: 401, message: UNLOCK_NEEDED } });
    expect(await liveGate("label", { clip_sha256: ownSha, unlock: "orbiT" })).toMatchObject({ live: false, refusal: { status: 403, message: UNLOCK_WRONG } });
    expect(await liveGate("label", { clip_sha256: ownSha, unlock: "a much longer guess than the code" })).toMatchObject({ refusal: { status: 403 } });
    expect(await liveGate("label", { clip_sha256: ownSha, unlock: " orbit " })).toEqual({ live: true, sample: false });
    expect([UNLOCK_NEEDED, UNLOCK_WRONG].every(isUnlockRefusal)).toBe(true);
  });

  it("in production without the code, replays a clip of your own and still labels a sample live", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await liveGate("label", { clip_sha256: ownSha, unlock: "anything" })).toEqual({ live: false, why: LIVE_CLOSED });
    expect(await liveGate("label", { clip_sha256: sampleSha })).toEqual({ live: true, sample: true });
    expect(console.info).not.toHaveBeenCalled();
  });

  it("warns when a sample's token cannot be made", async () => {
    vi.stubEnv(UNLOCK_ENV, "orbit");
    vi.stubEnv(TOKEN_ENV, "");
    expect(await liveGate("label", { clip_sha256: sampleSha })).toEqual({ live: true, sample: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`${TOKEN_ENV} is not set`));
  });
});

describe("the gate on the routes after the label", () => {
  beforeEach(() => vi.stubEnv(UNLOCK_ENV, "orbit"));

  it("goes live with the code or a sample's token, never on the spec's word", async () => {
    expect(await liveGate("compile", { unlock: "orbit" })).toEqual({ live: true, sample: false });
    expect(await liveGate("notes", { sample_token: sampleToken() })).toEqual({ live: true, sample: true });
    expect(await liveGate("ground", { clip_sha256: sampleSha })).toEqual({ live: false, why: LIVE_NEEDS_PASS });
    expect(await liveGate("variants", {})).toEqual({ live: false, why: LIVE_NEEDS_PASS });
  });

  it("says why it replays: a wrong code, a lapsed token, no secret to check one", async () => {
    expect(await liveGate("compile", { unlock: "nope" })).toEqual({ live: false, why: LIVE_WRONG_CODE });
    expect(await liveGate("compile", { sample_token: sampleToken(Date.now() - SAMPLE_TOKEN_TTL_S * 1000 - 1) })).toEqual({ live: false, why: LIVE_EXPIRED });
    vi.stubEnv(TOKEN_ENV, "");
    expect(await liveGate("compile", {})).toEqual({ live: false, why: LIVE_NO_SECRET });
  });

  it("in production without the code, opens only sample sessions", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv(UNLOCK_ENV, "");
    expect(await liveGate("compile", { unlock: "orbit" })).toEqual({ live: false, why: LIVE_CLOSED });
    expect(await liveGate("ground", {})).toEqual({ live: false, why: LIVE_CLOSED });
    expect(await liveGate("variants", { sample_token: sampleToken() })).toEqual({ live: true, sample: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("production deployment"));
  });

  it("stays open in local development without the code, and logs it", async () => {
    vi.stubEnv(UNLOCK_ENV, "");
    expect(await liveGate("notes", {})).toEqual({ live: true, sample: false });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("notes calls go live without a code"));
  });
});

describe("the ceiling on live calls per instance", () => {
  it("gives the reshoot list and the grid their own ceilings, so neither uses up the patch loop's (#193)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const t = Date.now();
    for (let i = 0; i < LIVE_PER_MINUTE.reshoot; i++) expect(takeLiveCall("reshoot", t)).toBe(true);
    expect(takeLiveCall("reshoot", t + 1000)).toBe(false);
    for (let i = 0; i < LIVE_PER_MINUTE.saboteur; i++) expect(takeLiveCall("saboteur", t)).toBe(true);
    expect(takeLiveCall("saboteur", t + 1000)).toBe(false);
    expect(takeLiveCall("notes", t + 1000)).toBe(true);
    expect(takeLiveCall("variants", t + 1000)).toBe(true);
  });

  it("is not counted outside a Vercel deployment", () => {
    for (let i = 0; i < 100; i++) expect(takeLiveCall("ground")).toBe(true);
  });

  it("holds a route to its calls per minute on a deployment, then frees them", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const t = Date.now();
    for (let i = 0; i < LIVE_PER_MINUTE.ground; i++) expect(takeLiveCall("ground", t)).toBe(true);
    expect(takeLiveCall("ground", t + 1000)).toBe(false);
    expect(takeLiveCall("compile", t + 1000)).toBe(true);
    expect(takeLiveCall("ground", t + 60_000)).toBe(true);
    // the gate answers the busy note once the minute's calls are taken
    for (let i = 0; i < LIVE_PER_MINUTE.label; i++) takeLiveCall("label");
    vi.stubEnv(UNLOCK_ENV, "orbit");
    expect(await liveGate("label", { clip_sha256: sampleSha })).toEqual({ live: false, why: LIVE_BUSY });
  });
});

describe("a replay the gate chose", () => {
  it("leads with the reason, which the page finds", () => {
    const r = explain(done(1, ["replay: recorded"]), { live: false, why: LIVE_NEEDS_PASS });
    expect(r).toMatchObject({ warnings: [LIVE_NEEDS_PASS, "replay: recorded"] });
    expect(gateNote(r.status === "done" ? r.warnings : [])).toBe(LIVE_NEEDS_PASS);
    expect(gateNote(["replay: recorded"])).toBeUndefined();
    expect(explain(failed("no recorded patch", false), { live: false, why: LIVE_CLOSED })).toMatchObject({ message: `no recorded patch (${LIVE_CLOSED})` });
    expect(explain(done(1), { live: true, sample: false })).toEqual(done(1));
    expect(explain(done(1), null)).toEqual(done(1));
  });
});
