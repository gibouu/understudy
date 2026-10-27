import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callModel } from "@/lib/providers/call";

const Answer = z.object({ n: z.number() });

/** A client that answers each create() from the list in turn: a string is the content, an Error is thrown. */
function fake(replies: (string | Error)[]) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          const r = replies.shift();
          if (r instanceof Error) throw r;
          return { choices: [{ message: { content: r } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, sent };
}

const opts = { role: "nano" as const, system: "s", user: "u", maxTokens: 100, schema: Answer };
const badRequest = () => new OpenAI.BadRequestError(400, { message: "unknown field" }, "400 unknown field", new Headers());

describe("callModel", () => {
  it("returns the parsed value with a ledger entry, thinking off and JSON mode on", async () => {
    const { client, sent } = fake(['{"n":1}']);
    const r = await callModel(client, opts);
    expect(r).toMatchObject({ status: "done", value: { n: 1 } });
    expect(r.status === "done" && r.ledger?.[0]).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
    expect(sent[0]).toMatchObject({ response_format: { type: "json_object" }, extra_body: { chat_template_kwargs: { enable_thinking: false } } });
  });

  it("retries a 400 once without JSON mode, thinking still off", async () => {
    const { client, sent } = fake([badRequest(), '{"n":2}']);
    expect(await callModel(client, opts)).toMatchObject({ status: "done", value: { n: 2 } });
    expect(sent[1]).not.toHaveProperty("response_format");
    expect(sent[1]).toMatchObject({ extra_body: { chat_template_kwargs: { enable_thinking: false } } });
    const thinking = fake([badRequest(), '{"n":2}']);
    await callModel(thinking.client, { ...opts, thinking: true });
    expect(thinking.sent[1]).not.toHaveProperty("extra_body");
  });

  it("asks once to fix what check finds, and keeps what is left as warnings", async () => {
    const check = (a: { n: number }) => (a.n < 0 ? ["n is negative"] : []);
    const fixed = fake(['{"n":-1}', '{"n":4}']);
    expect(await callModel(fixed.client, { ...opts, check })).toMatchObject({ status: "done", value: { n: 4 }, warnings: [] });
    expect(JSON.stringify(fixed.sent[1].messages)).toContain("n is negative");
    const stuck = fake(['{"n":-1}', '{"n":-2}']);
    expect(await callModel(stuck.client, { ...opts, check })).toMatchObject({ status: "done", value: { n: -2 }, warnings: ["nano: n is negative"] });
    const garbled = fake(['{"n":-1}', "no json"]);
    expect(await callModel(garbled.client, { ...opts, check })).toMatchObject({ status: "done", value: { n: -1 } });
    const offline = fake(['{"n":-1}', new Error("socket hang up")]);
    expect(await callModel(offline.client, { ...opts, check })).toMatchObject({ status: "done", value: { n: -1 } });
  });

  it("asks again once when the answer does not parse", async () => {
    const { client, sent } = fake(["no json", '{"n":3}']);
    expect(await callModel(client, opts)).toMatchObject({ status: "done", value: { n: 3 } });
    expect((sent[1].messages as unknown[]).length).toBe(4);
  });

  it("repeats the answer's shape when it asks again (#149)", async () => {
    const { client, sent } = fake(["no json", '{"n":3}']);
    await callModel(client, { ...opts, shape: '{"n":number}' });
    const again = (sent[1].messages as { content: string }[]).at(-1)!.content;
    expect(again).toContain('The shape is {"n":number}.');
    const { client: c2, sent: s2 } = fake(["no json", '{"n":3}']);
    await callModel(c2, opts);
    expect((s2[1].messages as { content: string }[]).at(-1)!.content).not.toContain("The shape is");
  });

  it("keeps the previous value after a second unusable answer, else fails", async () => {
    const kept = await callModel(fake(["no", '{"n":"x"}']).client, { ...opts, previous: { n: 0 } });
    expect(kept).toMatchObject({ status: "done", value: { n: 0 } });
    expect(kept.status === "done" && kept.warnings[0]).toMatch(/previous value kept/);
    expect(await callModel(fake(["no", "no"]).client, opts)).toMatchObject({ status: "failed" });
  });

  it("fails without retrying a second 400 or an auth error", async () => {
    expect(await callModel(fake([badRequest(), badRequest()]).client, opts)).toMatchObject({ status: "failed", retryable: false });
    const auth = new OpenAI.AuthenticationError(401, {}, "401", new Headers());
    expect(await callModel(fake([auth]).client, opts)).toMatchObject({ status: "failed", retryable: false });
  });
});
