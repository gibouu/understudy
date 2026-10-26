import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

describe("call log (scripts/call-log.mjs)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "call-log-"));
  const saved = { dir: process.env.UNDERSTUDY_CALL_LOG_DIR, key: process.env.NEBIUS_API_KEY, off: process.env.UNDERSTUDY_CALL_LOG };
  process.env.UNDERSTUDY_CALL_LOG_DIR = dir;
  process.env.NEBIUS_API_KEY = "test-key-0123456789";
  delete process.env.UNDERSTUDY_CALL_LOG;
  afterAll(() => {
    for (const [k, v] of [["UNDERSTUDY_CALL_LOG_DIR", saved.dir], ["NEBIUS_API_KEY", saved.key], ["UNDERSTUDY_CALL_LOG", saved.off]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("keeps the request and the answer in full, never a key or media, and links verdicts by id", async () => {
    const { logCall, logVerdict, scrub } = (await import("../../scripts/call-log.mjs")) as unknown as {
      logCall: (script: string, o: Record<string, unknown>) => string | null;
      logVerdict: (script: string, id: string | null, v: Record<string, unknown>) => void;
      scrub: (v: unknown) => unknown;
    };
    const video = `data:video/mp4;base64,${Buffer.alloc(3000, 7).toString("base64")}`;
    const params = {
      model: "nvidia/x",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "look; key test-key-0123456789" }, { type: "video_url", video_url: { url: video } }] },
      ],
      max_tokens: 800,
      response_format: { type: "json_object" },
      chat_template_kwargs: { enable_thinking: false },
    };
    const res = { choices: [{ message: { content: '{"set":{}}', reasoning_content: "thought" }, finish_reason: "stop" }] };
    const id = logCall("unit", { stage: "patch", params, res, usage: { prompt_tokens: 10 }, cost_usd: 0.001, meta: { arm: "a" }, session: "s1", parent: null });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    logVerdict("unit", id, { pass: true, score_before: 0.4, score_after: 1 });
    const failed = logCall("unit", { stage: "patch", params, error: "500 boom", cost_usd: 0.002, session: "s1", parent: id });
    expect(failed).not.toBe(id);

    const files = readdirSync(dir).filter((f) => f.startsWith("unit-"));
    expect(files).toHaveLength(1);
    const body = readFileSync(path.join(dir, files[0]), "utf8");
    expect(body).not.toContain("test-key-0123456789");
    expect(body).not.toContain(Buffer.alloc(30, 7).toString("base64"));
    const [call, verdict, fail] = body.trim().split("\n").map((l) => JSON.parse(l));
    expect(call).toMatchObject({ type: "call", id, script: "unit", stage: "patch", session: "s1", parent: null, model: "nvidia/x", output: { content: '{"set":{}}', reasoning: "thought", finish: "stop" }, cost_usd: 0.001 });
    expect(call.settings).toEqual({ max_tokens: 800, response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } });
    expect(call.input[1].content[0].text).toBe("look; key <redacted>");
    expect(call.input[1].content[1].video_url.url).toMatch(/^<data URI video\/mp4, 3000 bytes, sha256 [0-9a-f]{16}>$/);
    expect(verdict).toMatchObject({ type: "verdict", id, pass: true, score_after: 1 });
    expect(fail).toMatchObject({ type: "call", parent: id, output: null, error: "500 boom" });
    expect(scrub("plain text with data: inside")).toBe("plain text with data: inside");

    process.env.UNDERSTUDY_CALL_LOG = "0";
    expect(logCall("unit", { stage: "patch", params, res })).toBeNull();
    expect(readFileSync(path.join(dir, files[0]), "utf8")).toBe(body);
  });
});
