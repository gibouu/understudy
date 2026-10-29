/**
 * POST /api/ground {spec}: what the web says about this task, as opt-in chips.
 * Tavily `search` (basic) runs a query built from the spec, `extract` (basic)
 * pulls the passages of the top two pages that match it, and Nano labels the
 * sentences, from those and from every hit's snippet, that name one of the
 * spec's objects or verbs and read as advice (lib/spec/ground.ts).
 * The whole thing has 6 s: an error or an overrun answers with no chips and a
 * warning, never a failure, so the flow never waits on it. Tavily's request
 * ids and credits go in the ledger next to Nano's tokens. `unlock` or
 * `sample_token` lets it go live (lib/unlock/check.ts). Replay (?replay=1, no
 * Tavily or Token Factory key, or no way past the spend guard) answers from
 * tests/fixtures/ground.json: the recording for the same spec title, else no
 * chips.
 */
import { NextResponse } from "next/server";
import recordings from "@/tests/fixtures/ground.json";
import { callModel } from "@/lib/providers/call";
import { extract, hasTavilyKey, search, TavilyError, type Page } from "@/lib/providers/tavily";
import { tokenFactory, wantsReplay } from "@/lib/providers/tokenfactory";
import { candidatesOf, chipsFrom, GROUND_SYSTEM, groundQuery, groundSlots, groundUser, GroundFilter, type Grounding } from "@/lib/spec/ground";
import { TaskSpec } from "@/lib/spec/schema";
import { done, failed, type LedgerEntry, type StageResult } from "@/lib/spec/stage-result";
import { explain, liveGate } from "@/lib/unlock/check";

export const maxDuration = 15;

const BUDGET_MS = 6_000;
/** kept for Nano's filter: measured 0.3 to 2.8 s for about 1k prompt tokens on 26 Oct */
const FILTER_MS = 2_800;
/** Tavily's own extract deadline sits this far inside ours, so it answers with the pages it has read */
const EXTRACT_MARGIN_MS = 400;
const TOP_PAGES = 2;
/** Video and social pages: what extract reads there is comments and navigation, not prose about the task. */
const NO_PROSE = ["instagram.com", "facebook.com", "tiktok.com", "x.com", "twitter.com", "youtube.com", "pinterest.com", "reddit.com"];

/** An error's message only when it is ours: fetch and SDK errors can quote a header value. */
const why = (err: unknown) => (err instanceof TavilyError ? err.message : "internal error");

/** Every warning leaves with any fragment of either key cut out, whatever path it took. */
function redact(text: string): string {
  let out = text;
  for (const key of [process.env.TAVILY_API_KEY, process.env.NEBIUS_API_KEY]) {
    for (const part of (key ?? "").split(/\s+/)) if (part.length >= 8) out = out.split(part).join("[redacted]");
  }
  return out;
}

type Recording = { spec_title: string; recorded: string; result: StageResult<Grounding> };

function replay(spec: TaskSpec): StageResult<Grounding> {
  const r = (recordings as Recording[]).find((x) => x.spec_title === spec.title)?.result;
  // the ledger is the recording's: say that no call was made now
  if (r?.status === "done") return done(r.value, ["replay: a recording, no call made", ...r.warnings], r.ledger);
  return done({ query: groundQuery(spec), pages: [], chips: [] }, ["replay: no recorded grounding for this task"]);
}

async function ground(spec: TaskSpec, ledger: LedgerEntry[], warnings: string[], signal: AbortSignal, deadline: number): Promise<Grounding> {
  const query = groundQuery(spec);
  const { hits, entry } = await search(query, { maxResults: 5, excludeDomains: NO_PROSE, signal });
  ledger.push(entry);
  const top = hits.slice(0, TOP_PAGES);
  if (top.length === 0) {
    warnings.push("tavily: the search found nothing");
    return { query, pages: [], chips: [] };
  }
  const sources = hits.map((h) => ({ url: h.url, title: h.title }));

  // Every hit's search snippet is read, and extract adds the top pages' passages in the time left before
  // Nano's share. The snippet stays even then: on a redirect or a busy page extract can return the site's
  // navigation while the snippet holds the passage.
  let pages: Page[] = hits.map((h) => ({ url: h.url, content: h.content }));
  const extractMs = deadline - Date.now() - FILTER_MS;
  if (extractMs >= 1_000 + EXTRACT_MARGIN_MS) {
    try {
      const x = await extract(
        top.map((h) => h.url),
        { query, chunksPerSource: 3, timeoutS: (extractMs - EXTRACT_MARGIN_MS) / 1000, signal: AbortSignal.any([signal, AbortSignal.timeout(extractMs)]) },
      );
      ledger.push(x.entry);
      pages = hits.map((h) => ({ url: h.url, content: [h.content, x.pages.find((p) => p.url === h.url)?.content].filter(Boolean).join("\n\n") }));
      if (x.failed.length) warnings.push(`tavily: extract could not read ${x.failed.length} page(s); only their search snippets were read`);
    } catch (err) {
      if (signal.aborted) throw err;
      // an aborted extract is missing from the ledger: Tavily never answered with its credits
      warnings.push(`tavily: extract failed (${why(err)}); only the search snippets were read`);
    }
  } else warnings.push("tavily: no time left to extract; only the search snippets were read");

  const candidates = candidatesOf(spec, pages.map((p) => ({ ...p, title: hits.find((h) => h.url === p.url)?.title ?? "" })));
  if (candidates.length === 0) {
    warnings.push("no sentence on the pages found both names this task and gives advice: Nano was not asked");
    return { query, pages: sources, chips: [] };
  }
  const base = tokenFactory({ timeout: Math.max(1_000, deadline - Date.now()), maxRetries: 0 });
  if (!base) throw new TavilyError("no NEBIUS_API_KEY");
  // the stage's deadline aborts Nano too, a second attempt included, so nothing runs on after the answer
  const client = base.withOptions({ fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }) });
  const slots = groundSlots(spec);
  const r = await callModel(client, {
    role: "nano",
    system: GROUND_SYSTEM,
    user: groundUser(spec, candidates, slots),
    maxTokens: 200,
    schema: GroundFilter,
  });
  // a failed answer still cost its calls (#106)
  if (r.status === "done" || r.status === "failed") ledger.push(...(r.ledger ?? []));
  if (r.status !== "done") {
    // callModel's message can quote an SDK error, cut to a length the redaction no longer matches: say what happened in our words
    warnings.push(r.status === "failed" ? `nano: ${r.retryable ? "no answer (network, rate limit or timeout)" : "no usable answer"}` : "nano: no answer");
    return { query, pages: sources, chips: [] };
  }
  const { chips, warnings: dropped } = chipsFrom(candidates, r.value, slots);
  warnings.push(...r.warnings, ...dropped);
  return { query, pages: sources, chips };
}

export async function POST(req: Request): Promise<NextResponse<StageResult<Grounding>>> {
  const body = await req.json().catch(() => null);
  const spec = TaskSpec.safeParse(body?.spec);
  if (!spec.success) return NextResponse.json(failed(`invalid spec: ${spec.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, false), { status: 400 });
  if (wantsReplay(req) || !hasTavilyKey()) return NextResponse.json(replay(spec.data));
  const gate = await liveGate("ground", body);
  if (!gate.live) return NextResponse.json(explain(replay(spec.data), gate));

  const ledger: LedgerEntry[] = [];
  const warnings: string[] = [];
  const empty: Grounding = { query: groundQuery(spec.data), pages: [], chips: [] };
  const controller = new AbortController();
  const deadline = Date.now() + BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<{ over: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ over: true });
    }, BUDGET_MS);
  });
  const work = ground(spec.data, ledger, warnings, controller.signal, deadline).then(
    (value) => ({ value }),
    (err: unknown) => ({ err }),
  );
  try {
    const r = await Promise.race([work, overrun]);
    // a snapshot: a call still in flight at the deadline is missing from this ledger
    if ("over" in r) return NextResponse.json(done(empty, [...warnings, `grounding took over ${BUDGET_MS / 1000} s`].map(redact), [...ledger]));
    if ("err" in r) return NextResponse.json(done(empty, [...warnings, `grounding failed: ${why(r.err)}`].map(redact), [...ledger]));
    return NextResponse.json(done(r.value, warnings.map(redact), ledger));
  } finally {
    clearTimeout(timer);
  }
}
