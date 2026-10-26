import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recordings from "@/tests/fixtures/ground.json";
import compiled from "@/tests/fixtures/compile.json";
import { POST } from "@/app/api/ground/route";
import { applyChanges } from "@/lib/spec/apply";
import { chipChange, type Grounding } from "@/lib/spec/ground";
import { TaskSpec } from "@/lib/spec/schema";
import type { StageResult } from "@/lib/spec/stage-result";

type Done = Extract<StageResult<Grounding>, { status: "done" }>;

const recorded = recordings[0];
const spec = TaskSpec.parse(compiled.find((r) => r.spec.title === recorded.spec_title)!.spec);
const other = TaskSpec.parse({ ...spec, title: "a task nobody recorded" });

const post = async (body: unknown, query = "") => {
  const res = await POST(new Request(`http://x/api/ground${query}`, { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as StageResult<Grounding> };
};

describe("POST /api/ground in replay", () => {
  it("answers with the recording for the same spec title, marked as a replay", async () => {
    const { json } = await post({ spec }, "?replay=1");
    const r = json as Done;
    expect(r.status).toBe("done");
    expect(r.warnings[0]).toBe("replay: a recording, no call made");
    expect(r.value.chips.length).toBeGreaterThan(0);
    expect(r.ledger?.filter((e) => e.model.startsWith("tavily/")).every((e) => e.request_id && e.credits !== undefined)).toBe(true);
  });

  it("every recorded chip applies to the spec with a tavily source", async () => {
    const r = (await post({ spec }, "?replay=1")).json as Done;
    for (const chip of r.value.chips) {
      const { spec: next, warnings } = applyChanges(spec, [chipChange(spec, chip)]);
      expect(warnings).toEqual([]);
      expect(JSON.stringify(next.sources) + JSON.stringify(next.objects.map((o) => o.sources))).toContain(`tavily:${chip.url}`);
    }
  });

  it("answers no chips, never a failure, for a task with no recording", async () => {
    const r = (await post({ spec: other }, "?replay=1")).json as Done;
    expect(r).toMatchObject({ status: "done", value: { chips: [] }, warnings: ["replay: no recorded grounding for this task"] });
  });

  it("refuses a body that is not a spec", async () => {
    const { status, json } = await post({ spec: { title: 1 } }, "?replay=1");
    expect(status).toBe(400);
    expect(json.status).toBe("failed");
  });
});

/** Tavily and Token Factory answered from a table; a handler that returns undefined never answers until aborted. */
function fakeNetwork(h: { search?: () => unknown; extract?: () => unknown; nano?: () => string }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = url.endsWith("/search") ? h.search?.() : url.endsWith("/extract") ? h.extract?.() : url.includes("/chat/completions") ? h.nano && { nano: h.nano() } : undefined;
    if (reply instanceof Response) return reply;
    if (reply === undefined) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (typeof reply === "object" && reply && "nano" in reply) {
      return json({
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: (reply as { nano: string }).nano } }],
        usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740 },
      });
    }
    return json(reply);
  });
  return { fetch, calls, json };
}

const HIT = "https://lab.example.org/racks";
const SEARCH = {
  results: [
    { url: HIT, title: "Lab racks", content: "Seed film should be moistened before it goes into the plant pillow wicks.", score: 0.9 },
    { url: "https://other.example.org/x", title: "Other", content: "Plant pillows are made of Teflon cloth and hold a substrate.", score: 0.5 },
  ],
  usage: { credits: 1 },
  request_id: "search-1",
};
const EXTRACT = {
  results: [{ url: HIT, raw_content: "Never press the seed film packet into the plant pillow with a dry glove, or it tears." }],
  failed_results: [{ url: "https://other.example.org/x", error: "blocked" }],
  usage: { credits: 1 },
  request_id: "extract-1",
};

describe("POST /api/ground live, with the network faked", () => {
  beforeEach(() => {
    vi.stubEnv("TAVILY_API_KEY", "test-tavily");
    vi.stubEnv("NEBIUS_API_KEY", "test-nebius");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("searches, extracts the top pages, has Nano label the advice and logs every call", async () => {
    const net = fakeNetwork({ search: () => SEARCH, extract: () => EXTRACT, nano: () => '{"labels":{"0":"hazard","1":"precondition"},"numbers":[]}' });
    vi.stubGlobal("fetch", net.fetch);
    const r = (await post({ spec })).json as Done;
    expect(r.status).toBe("done");
    expect(r.value.chips.map((c) => [c.kind, c.url])).toEqual([
      ["hazard", HIT],
      ["precondition", HIT],
    ]);
    expect(r.value.chips.map((c) => c.text)).toEqual([
      "Never press the seed film packet into the plant pillow with a dry glove, or it tears.",
      "Seed film should be moistened before it goes into the plant pillow wicks.",
    ]);
    expect(r.ledger?.map((e) => [e.model, e.request_id, e.credits])).toEqual([
      ["tavily/search", "search-1", 1],
      ["tavily/extract", "extract-1", 1],
      [expect.stringContaining("Nano"), undefined, undefined],
    ]);
    const [search, extract] = net.calls;
    expect(search.body).toMatchObject({ search_depth: "basic", include_usage: true });
    expect(extract.body).toMatchObject({ urls: [HIT, "https://other.example.org/x"], extract_depth: "basic", include_usage: true });
    expect(JSON.stringify(net.calls)).not.toContain("test-tavily");
  });

  it("does not ask Nano when no sentence names the task and gives advice", async () => {
    const net = fakeNetwork({ search: () => ({ ...SEARCH, results: [SEARCH.results[1]] }), extract: () => ({ results: [], usage: { credits: 0 }, request_id: "e" }) });
    vi.stubGlobal("fetch", net.fetch);
    const r = (await post({ spec })).json as Done;
    expect(r.value.chips).toEqual([]);
    expect(r.warnings.at(-1)).toMatch(/Nano was not asked/);
    expect(net.calls.some((c) => c.url.includes("/chat/completions"))).toBe(false);
  });

  it("never puts a key in the answer, even when fetch quotes it", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-dev-abcdefgh\nijklmnop");
    const r = (await post({ spec })).json as Done;
    expect(r.warnings.at(-1)).toBe("grounding failed: tavily search: network error");
    expect(JSON.stringify(r)).not.toMatch(/abcdefgh|ijklmnop/);
  });

  it("answers no chips, never a failure, when Tavily refuses", async () => {
    const net = fakeNetwork({});
    net.fetch.mockImplementation(async () => net.json({ detail: { error: "Unauthorized" } }, 401));
    vi.stubGlobal("fetch", net.fetch);
    const r = (await post({ spec })).json as Done;
    expect(r).toMatchObject({ status: "done", value: { chips: [] } });
    expect(r.warnings.at(-1)).toBe("grounding failed: tavily search: HTTP 401");
  });

  it("answers at the 6 s budget when Nano hangs, with the Tavily calls it logged", async () => {
    vi.useFakeTimers();
    const net = fakeNetwork({ search: () => SEARCH, extract: () => EXTRACT });
    vi.stubGlobal("fetch", net.fetch);
    const pending = post({ spec });
    await vi.advanceTimersByTimeAsync(6_000);
    const r = (await pending).json as Done;
    expect(r).toMatchObject({ status: "done", value: { chips: [] } });
    expect(r.warnings.at(-1)).toBe("grounding took over 6 s");
    expect(r.ledger?.map((e) => e.model)).toEqual(["tavily/search", "tavily/extract"]);
    // Nano's request is aborted with the answer, not left running
    const nano = net.fetch.mock.calls.find(([u]) => String(u instanceof Request ? u.url : u).includes("/chat/completions"));
    expect(nano?.[1]?.signal?.aborted).toBe(true);
  });

  it("answers at the 6 s budget when Tavily hangs", async () => {
    vi.useFakeTimers();
    const net = fakeNetwork({});
    vi.stubGlobal("fetch", net.fetch);
    const pending = post({ spec });
    await vi.advanceTimersByTimeAsync(5_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = (await pending).json as Done;
    expect(r).toMatchObject({ status: "done", value: { chips: [] }, ledger: [] });
    expect(r.warnings.at(-1)).toBe("grounding took over 6 s");
    expect(net.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
