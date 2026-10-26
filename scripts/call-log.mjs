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
// moves them; UNDERSTUDY_CALL_LOG=0 turns the log off). Never in a record: a key (NEBIUS_API_KEY,
// TAVILY_API_KEY and UNDERSTUDY_ENDPOINT_TOKEN are redacted from every line) or media (every base64 data: URI, anywhere in
// the record, becomes its type, size and hash, so a clip or a frame never lands in the log, only
// the tokens and text derived from it). The log never stops a run: a write that fails is reported
// once on stderr and the run goes on.
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

// any case ("DATA:", ";BASE64,"); a payload wrapped over lines is taken whole. One character
// class, no alternation: V8 then matches a clip of many megabytes without recursing.
const DATA_URI = /data:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+=[^;,\s]*)*);base64,([A-Za-z0-9+/\r\n]*={0,2})/gi;
/** every base64 data: URI anywhere in the value becomes a short description of it */
export function scrub(v) {
  if (typeof v === "string") {
    return v.replace(DATA_URI, (_m, mime, _params, raw) => {
      const body = raw.replace(/\s/g, "");
      const bytes = Math.floor((body.length * 3) / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
      return `<data URI ${mime || "?"}, ${bytes} bytes, sha256 ${createHash("sha256").update(body).digest("hex").slice(0, 16)}>`;
    });
  }
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

let warned = false;
function append(script, rec) {
  try {
    let line = JSON.stringify(scrub(rec));
    for (const s of [process.env.NEBIUS_API_KEY, process.env.TAVILY_API_KEY, process.env.UNDERSTUDY_ENDPOINT_TOKEN]) if (s && s.length >= 8) line = line.split(s).join("<redacted>");
    appendFileSync(fileFor(script), `${line}\n`);
  } catch (e) {
    if (!warned) console.error(`call log: could not write a record (${e?.code ?? e?.message ?? e}); the run goes on without it`);
    warned = true;
  }
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
  append(script, { type: "call", id, t: new Date().toISOString(), script, stage, session, parent, model, settings, input: messages, output, error, usage, cost_usd, meta });
  return id;
}

/** the outcome of a logged call's answer, once the caller has measured it */
export function logVerdict(script, id, verdict) {
  if (off() || !id) return;
  append(script, { type: "verdict", id, t: new Date().toISOString(), script, ...verdict });
}
