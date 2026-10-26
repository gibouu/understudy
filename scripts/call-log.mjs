// The call log (issue #78): one append-only JSONL record per model call in the bench scripts and
// the patch loop, kept as training data for a future fine-tune. A record holds what the model saw
// (the messages and settings), what it said (content and reasoning), the cost, and ids that rebuild
// a trajectory (session, parent call); where the caller can judge the answer, a later "verdict"
// record carries the simulator's verdict on it, linked by the call's id.
//
//   const id = logCall("bench-x", { stage, params, res, usage, cost_usd, meta, session, parent });
//   logVerdict("bench-x", id, { pass, score_before, score_after });
//
// Files: bench/calls/<script>-<start time>-<pid>.jsonl, one per process (UNDERSTUDY_CALL_LOG_DIR
// moves them; UNDERSTUDY_CALL_LOG=0 turns the log off). Never in a record: a key (NEBIUS_API_KEY
// and TAVILY_API_KEY are redacted from every line) or media (a data: URI becomes its type, size and
// hash, so a clip or a frame never lands in the log, only the tokens and text derived from it).
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const files = new Map();
const dir = () => process.env.UNDERSTUDY_CALL_LOG_DIR ?? path.join(process.cwd(), "bench/calls");
const off = () => process.env.UNDERSTUDY_CALL_LOG === "0";

function fileFor(script) {
  if (!files.has(script)) {
    mkdirSync(dir(), { recursive: true });
    files.set(script, path.join(dir(), `${script}-${STAMP}-${process.pid}.jsonl`));
  }
  return files.get(script);
}

/** a data: URI anywhere in the value becomes a short description of it */
export function scrub(v) {
  if (typeof v === "string") {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,/.exec(v);
    if (!m) return v;
    const body = v.slice(m[0].length);
    return `<data URI ${m[1] || "?"}, ${Math.floor((body.length * 3) / 4)} bytes, sha256 ${createHash("sha256").update(body).digest("hex").slice(0, 16)}>`;
  }
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

function append(script, rec) {
  let line = JSON.stringify(rec);
  for (const s of [process.env.NEBIUS_API_KEY, process.env.TAVILY_API_KEY]) if (s && s.length >= 8) line = line.split(s).join("<redacted>");
  appendFileSync(fileFor(script), `${line}\n`);
}

/**
 * Log one call. params: the chat.completions request as sent; res: the response (null when the
 * call failed, then `error` says why). Returns the record's id, or null when the log is off.
 */
export function logCall(script, { stage, params, res = null, usage = null, cost_usd = null, meta = {}, session = null, parent = null, error = null }) {
  if (off()) return null;
  const id = randomUUID();
  const { model, messages, ...settings } = params;
  const msg = res?.choices?.[0]?.message ?? {};
  const output = res ? { content: msg.content ?? "", reasoning: msg.reasoning_content ?? msg.reasoning ?? null, finish: res.choices?.[0]?.finish_reason ?? null } : null;
  append(script, { type: "call", id, t: new Date().toISOString(), script, stage, session, parent, model, settings: scrub(settings), input: scrub(messages), output, error, usage, cost_usd, meta });
  return id;
}

/** the outcome of a logged call's answer, once the caller has measured it */
export function logVerdict(script, id, verdict) {
  if (off() || !id) return;
  append(script, { type: "verdict", id, t: new Date().toISOString(), script, ...verdict });
}
