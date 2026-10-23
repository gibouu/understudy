// Day-one smoke tests against Nebius Token Factory (issue #2). Decides the
// Label input and the thinking toggle before anything is built on them.
//
//   node scripts/smoke-tokenfactory.mjs --frames <dir of jpg> --montage <jpg> [--video <small mp4>] [--out results.json]
//
// Reads NEBIUS_API_KEY and the UNDERSTUDY_MODEL_* ids from .env.local. Prints a
// markdown table for docs/FEEDBACK.md and writes raw results (no secrets).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";

process.loadEnvFile(".env.local");
// --flag value, or --flag alone (boolean) when the next token is another flag or missing
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  args[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : next;
}
if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from .env.local");
/** never let the key reach stdout or the results file, whatever an error message contains */
const redact = (s) => String(s).split(process.env.NEBIUS_API_KEY).join("<redacted>");

const client = new OpenAI({ apiKey: process.env.NEBIUS_API_KEY, baseURL: "https://api.tokenfactory.nebius.com/v1/", timeout: 120_000, maxRetries: 0 });
const MODELS = {
  vl: process.env.UNDERSTUDY_MODEL_VL ?? "nvidia/Nemotron-3.5-Super-VL",
  nano: process.env.UNDERSTUDY_MODEL_NANO ?? "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  super: process.env.UNDERSTUDY_MODEL_SUPER ?? "nvidia/nemotron-3-super-120b-a12b",
};

const results = [];
const b64 = (file, mime) => `data:${mime};base64,${readFileSync(file).toString("base64")}`;

async function run(name, model, params) {
  const started = performance.now();
  try {
    const res = await client.chat.completions.create({ model, ...params });
    const text = res.choices?.[0]?.message?.content ?? "";
    const reasoning = res.choices?.[0]?.message?.reasoning_content ?? res.choices?.[0]?.message?.reasoning ?? null;
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    } catch {
      /* not JSON */
    }
    const r = {
      name,
      model,
      ok: true,
      ms: Math.round(performance.now() - started),
      usage: res.usage,
      finish: res.choices?.[0]?.finish_reason,
      has_think_tag: /<think>/.test(text),
      has_reasoning_field: Boolean(reasoning),
      json_ok: parsed !== null,
      json_keys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 8) : null,
      text_head: text.slice(0, 160),
    };
    results.push(r);
    console.log(`✓ ${name}: ${r.ms} ms, in ${res.usage?.prompt_tokens} / out ${res.usage?.completion_tokens}${res.usage?.completion_tokens_details?.reasoning_tokens ? ` (reasoning ${res.usage.completion_tokens_details.reasoning_tokens})` : ""}, json ${r.json_ok}, think-tag ${r.has_think_tag}`);
  } catch (err) {
    const r = { name, model, ok: false, ms: Math.round(performance.now() - started), status: err?.status, error: redact(err?.message ?? err).slice(0, 300) };
    results.push(r);
    console.log(`✗ ${name}: HTTP ${r.status ?? "?"} ${r.error}`);
  }
}

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    objects: { type: "array", items: { type: "object", properties: { id: { type: "string" }, shape: { type: "string", enum: ["cylinder", "box", "sphere"] }, size_mm: { type: "array", items: { type: "number" } } }, required: ["id", "shape", "size_mm"] } },
    segments: { type: "array", items: { type: "object", properties: { verb: { type: "string" }, object: { type: "string" }, t_start_s: { type: "number" }, t_end_s: { type: "number" } }, required: ["verb", "object", "t_start_s", "t_end_s"] } },
  },
  required: ["title", "objects", "segments"],
};
const LABEL_PROMPT = `You watch keyframes of one person doing a tabletop task. Return JSON only, shaped like this schema: ${JSON.stringify(LABEL_SCHEMA)}. Each keyframe is captioned with its time in seconds. Objects are primitives (cylinder, box, sphere) with size_mm as [x, y, z] in millimetres. Segments are the steps (reach, grasp, move, insert, place, release) with times.`;

// --- Label input ------------------------------------------------------------
// Token Factory caps Super VL at 8 images per request (HTTP 400 beyond), so the
// keyframe path is 7 keyframes plus one montage; the video path sends one proxy.
const MAX_IMAGES = 8;
const thinkOff = { extra_body: { chat_template_kwargs: { enable_thinking: false } } };
if (args.frames) {
  const files = readdirSync(args.frames).filter((f) => f.endsWith(".jpg")).sort();
  const picked = files.filter((_, i) => i % Math.ceil(files.length / (MAX_IMAGES - 1)) === 0).slice(0, MAX_IMAGES - 1);
  const content = [{ type: "text", text: LABEL_PROMPT }];
  picked.forEach((f, i) => {
    content.push({ type: "text", text: `keyframe ${i + 1} of ${picked.length}` });
    content.push({ type: "image_url", image_url: { url: b64(path.join(args.frames, f), "image/jpeg") } });
  });
  if (args.montage) {
    content.push({ type: "text", text: "montage of all keyframes, left to right, top to bottom" });
    content.push({ type: "image_url", image_url: { url: b64(args.montage, "image/jpeg") } });
  }
  await run(`vl ${picked.length} keyframes+montage thinking off json_object`, MODELS.vl, { messages: [{ role: "user", content }], response_format: { type: "json_object" }, max_tokens: 1500, ...thinkOff });
  await run(`vl ${picked.length} keyframes+montage thinking off json_schema`, MODELS.vl, { messages: [{ role: "user", content }], response_format: { type: "json_schema", json_schema: { name: "label", schema: LABEL_SCHEMA } }, max_tokens: 1500, ...thinkOff });
}
for (const [label, file] of [["proxy", args.video], ["full clip", args.video2]]) {
  if (!file) continue;
  const content = [
    { type: "text", text: LABEL_PROMPT.replace("keyframes", "a short video") },
    { type: "video_url", video_url: { url: b64(file, "video/mp4") } },
  ];
  await run(`vl video ${label} thinking off json_object`, MODELS.vl, { messages: [{ role: "user", content }], response_format: { type: "json_object" }, max_tokens: 1500, ...thinkOff });
  if (label === "proxy") {
    await run("vl video proxy thinking off json_schema", MODELS.vl, { messages: [{ role: "user", content }], response_format: { type: "json_schema", json_schema: { name: "label", schema: LABEL_SCHEMA } }, max_tokens: 1500, ...thinkOff });
    await run("vl video proxy reasoning_effort none", MODELS.vl, { messages: [{ role: "user", content }], response_format: { type: "json_object" }, max_tokens: 1500, reasoning_effort: "none" });
    await run("vl video proxy thinking on, 6k budget", MODELS.vl, { messages: [{ role: "user", content }], response_format: { type: "json_object" }, max_tokens: 6000 });
  }
}
if (args["skip-text"]) {
  const rows = results.map((r) => `| ${r.name} | ${r.ok ? `ok, ${r.ms} ms, in ${r.usage?.prompt_tokens} / out ${r.usage?.completion_tokens}${r.usage?.completion_tokens_details?.reasoning_tokens ? `, reasoning ${r.usage.completion_tokens_details.reasoning_tokens}` : ""}, json ${r.json_ok ? "yes" : "no"}` : `HTTP ${r.status ?? "?"}: ${r.error}`} |`);
  console.log("\n| test | result |\n|---|---|\n" + rows.join("\n"));
  if (args.out) writeFileSync(args.out, JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + "\n");
  process.exit(0);
}

// --- Thinking toggles on the text models -------------------------------------
const COMPILE_PROMPT = `Return JSON only: {"steps":[{"step_id":"s1","ops":[...]}]} where ops are move_to(frame, offset_mm), grasp(object, aperture_mm), release, and ask(slot, question) for anything you cannot decide. Task: pick a 15 mm marker from a tray at (250, -100) mm and insert it into a rack pocket at (250, 100) mm with 3 mm clearance. Keep it under 400 tokens.`;
for (const role of ["nano", "super"]) {
  const model = MODELS[role];
  const base = { messages: [{ role: "user", content: COMPILE_PROMPT }], response_format: { type: "json_object" }, max_tokens: 1200 };
  await run(`${role} default`, model, base);
  await run(`${role} reasoning_effort none`, model, { ...base, reasoning_effort: "none" });
  await run(`${role} enable_thinking false`, model, { ...base, extra_body: { chat_template_kwargs: { enable_thinking: false } } });
  await run(`${role} unknown param`, model, { ...base, extra_body: { bogus_param_for_test: 1 } });
}

// --- Output ----------------------------------------------------------------
const rows = results.map((r) => `| ${r.name} | ${r.model} | ${r.ok ? `ok, ${r.ms} ms, in ${r.usage?.prompt_tokens ?? "?"} / out ${r.usage?.completion_tokens ?? "?"}${r.usage?.completion_tokens_details?.reasoning_tokens ? `, reasoning ${r.usage.completion_tokens_details.reasoning_tokens}` : ""}, json ${r.json_ok ? "yes" : "no"}, think-tag ${r.has_think_tag ? "yes" : "no"}` : `HTTP ${r.status ?? "?"}: ${r.error}`} |`);
console.log("\n| test | model | result |\n|---|---|---|\n" + rows.join("\n"));
if (args.out) writeFileSync(args.out, JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + "\n");
