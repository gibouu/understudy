/**
 * Sessions given for training (#78): /api/keep keeps a record only with the
 * consent flag and a session id, never the unlock code or a sample token, and
 * stops at its share of the free store. The store is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_LINE, KeepRequest, scrub } from "@/lib/keep/record";
import { BYTES_KEY, KEEP_MAX_BYTES, KEEP_PREFIX, keepRecord, SESSIONS_KEY } from "@/lib/keep/store";
import { done } from "@/lib/spec/stage-result";
import { fakeRedis } from "@/tests/store/fake-redis";

const { POST } = await import("@/app/api/keep/route");
const keep = async (body: unknown) => {
  const res = await POST(new Request("http://localhost/api/keep", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { kept: boolean; why?: string } };
};

const session = "0b6c3f7e-9a51-4c1e-8d2f-3e4a5b6c7d8e";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the consent line", () => {
  it("is the one the page shows", () => {
    expect(CONSENT_LINE).toBe("Clips you submit, with what the models made of them, may be kept and used to improve Understudy and to train models.");
  });
});

describe("POST /api/keep", () => {
  it("keeps nothing without the consent flag or a session id", async () => {
    const store = fakeRedis();
    expect((await keep({ session, kind: "label", data: {} })).status).toBe(400);
    expect((await keep({ session, consent: false, kind: "label", data: {} })).status).toBe(400);
    expect((await keep({ session: "mine", consent: true, kind: "label", data: {} })).status).toBe(400);
    expect((await keep({ session, consent: true, kind: "anything", data: {} })).status).toBe(400);
    expect(store.requests).toHaveLength(0);
  });

  it("keeps a consented record under its session, without what passes the spend guard", async () => {
    const store = fakeRedis();
    const r = await keep({ session, consent: true, kind: "compile", data: { request: { spec: { title: "t" }, unlock: "the code", nested: [{ sample_token: "tok" }] }, result: { status: "done" } } });
    expect(r.body).toEqual({ kept: true });
    const list = store.data.get(`${KEEP_PREFIX}:${session}`) as string[];
    expect(list).toHaveLength(1);
    expect(list[0]).not.toContain("the code");
    expect(list[0]).not.toContain("tok");
    expect(JSON.parse(list[0])).toMatchObject({ kind: "compile", data: { request: { spec: { title: "t" }, nested: [{}] } } });
    expect((store.data.get(SESSIONS_KEY) as Map<string, number>).has(session)).toBe(true);
  });

  it("answers without keeping when there is no store, or the store is down", async () => {
    expect((await keep({ session, consent: true, kind: "label", data: {} })).body).toMatchObject({ kept: false });
    const store = fakeRedis();
    store.down = true;
    expect((await keep({ session, consent: true, kind: "label", data: {} })).body).toMatchObject({ kept: false, why: "the store did not answer" });
  });
});

describe("keepRecord", () => {
  it("stops at its share of the store and gives the room back", async () => {
    const store = fakeRedis();
    store.data.set(BYTES_KEY, KEEP_MAX_BYTES - 10);
    const r = KeepRequest.parse({ session, consent: true, kind: "clip", data: { video: "data:video/mp4;base64,AAAA" } });
    expect(await keepRecord(r)).toEqual({ kept: false, why: "the store for kept sessions is full" });
    expect(store.data.get(BYTES_KEY)).toBe(KEEP_MAX_BYTES - 10);
    expect(store.data.has(`${KEEP_PREFIX}:${session}`)).toBe(false);
  });

  it("scrubs secrets at any depth and leaves the rest", () => {
    expect(scrub({ a: 1, unlock: "x", b: [{ sample_token: "y", c: 2 }] })).toEqual({ a: 1, b: [{ c: 2 }] });
  });
});

describe("the page's side (app/keep.ts)", () => {
  it("sends nothing without consent, the clip apart from the label once it is given, and nothing for a session no longer current", async () => {
    const { keep: send, keepCall, keeping, startSession } = await import("@/app/keep");
    const sent: { session: string; kind: string; consent: boolean; data: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (_: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ kept: true });
    });
    const label = done({});
    expect(startSession(false)).toBeUndefined();
    keepCall("/api/label", { video: "data:video/mp4;base64,AAAA", hint: "h" }, label, keeping());
    send("answers", {}, keeping());
    expect(sent).toHaveLength(0);

    const a = startSession(true);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    keepCall("/api/label", { video: "data:video/mp4;base64,AAAA", clip_sha256: "c", hint: "h" }, label, keeping());
    keepCall("/api/models", {}, label, keeping());
    expect(sent.map((r) => r.kind)).toEqual(["clip", "label"]);
    expect(sent.every((r) => r.consent === true && r.session === a)).toBe(true);
    expect(sent[1].data.request).toEqual({ clip_sha256: "c", hint: "h" });

    // an answer to a request begun under clip A lands after the box was unticked, or after clip B was chosen
    startSession(false);
    keepCall("/api/compile", {}, label, a);
    send("rehearsal", {}, a);
    startSession(true);
    keepCall("/api/compile", {}, label, a);
    // a step begun with the box unticked stays unkept after it is ticked again
    startSession(false);
    const none = keeping();
    startSession(true);
    send("rehearsal", {}, none);
    keepCall("/api/notes", {}, label, none);
    expect(sent).toHaveLength(2);
    startSession(false);
  });
});
