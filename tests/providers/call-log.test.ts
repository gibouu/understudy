import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // media inside text, in answers and in errors is scrubbed too
    const b64 = Buffer.alloc(600, 9).toString("base64");
    expect(scrub(`see data:image/png;base64,${b64} and more`)).toMatch(/^see <data URI image\/png, 600 bytes, sha256 [0-9a-f]{16}> and more$/);
    // any case, and a payload wrapped over lines
    for (const uri of [`DATA:image/png;base64,${b64}`, `data:image/png;BASE64,${b64}`, `data:image/png;base64,${b64.match(/.{1,76}/g)!.join("\r\n")}`]) {
      const out = String(scrub(`x ${uri}`));
      expect(out).toMatch(/^x <data URI image\/png, 600 bytes, sha256 [0-9a-f]{16}>$/);
      expect(out).toBe(String(scrub(`x data:image/png;base64,${b64}`)));
    }
    const echo = logCall("unit", { stage: "patch", params, res: { choices: [{ message: { content: `echo data:video/mp4;base64,${b64}` } }] }, error: `400 bad data:;base64,${b64}` });
    const echoed = readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.id === echo);
    expect(JSON.stringify(echoed)).not.toContain(b64.slice(0, 40));
    expect(echoed.error).toMatch(/^400 bad <data URI \?, 600 bytes/);
    const after = readFileSync(path.join(dir, files[0]), "utf8");

    process.env.UNDERSTUDY_CALL_LOG = "0";
    expect(logCall("unit", { stage: "patch", params, res })).toBeNull();
    expect(readFileSync(path.join(dir, files[0]), "utf8")).toBe(after);
  });

  it("never stops a run when a record cannot be written", async () => {
    const { logCall } = (await import("../../scripts/call-log.mjs")) as unknown as { logCall: (script: string, o: Record<string, unknown>) => string | null };
    delete process.env.UNDERSTUDY_CALL_LOG;
    // a regular file where the log directory should be: mkdir fails
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.UNDERSTUDY_CALL_LOG_DIR = blocker;
    expect(() => logCall("unwritable", { stage: "patch", params: { model: "m", messages: [] } })).not.toThrow();
  });
});
