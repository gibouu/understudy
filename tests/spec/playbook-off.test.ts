/**
 * #56: with the playbook switch off, /api/compile sends Token Factory exactly what it sent before the
 * playbook existed, and answers exactly the same. The hashes below were taken from the route on
 * next/after-submit at 0577200, before lib/spec/playbook.ts was written; Token Factory is faked.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Session } from "@/lib/showcase/session";

const sent: unknown[] = [];
const session = (clip: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public", "showcase", `${clip}.json`), "utf8")));

vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const tf = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...tf,
    wantsReplay: () => false,
    tokenFactory: () => ({
      models: { list: async () => ({ data: Object.values(tf.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: async (args: { messages: { content: string }[] }) => {
            sent.push(args);
            const title = /"title":"([^"]*)"/.exec(args.messages[1].content)![1];
            const program = [session("iss-glovebox-pipette"), session("iss-veggie-seed-film")].flatMap((s) => s.iterations).find((it) => it.spec.title === title)!.program;
            return { choices: [{ message: { content: JSON.stringify(program) } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
          },
        },
      },
    }),
  };
});

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

describe("the playbook switch off", () => {
  it.each([
    ["iss-glovebox-pipette", 1, "d1cbad7a06ab049312c0703995451547d5821a6d927c92206b143b7869e162f9", "136089731a63069dc0e89dcd0fdd6110516f596f74432d456beecd223792df62"],
    ["iss-veggie-seed-film", 1, "31f565e1037e4bd2e248b33d2ce960f5b48675b3f6e09e430508f8dede964ed6", "0dadfcb5233b898e7b906dc3e4539816f313627116e7aa509a553ba2b518dba6"],
  ] as const)("%s: the request and the answer are the ones from before the playbook", async (clip, i, request, reply) => {
    const { POST } = await import("@/app/api/compile/route");
    const spec = session(clip).iterations[i].spec;
    sent.length = 0;
    const res = await POST(new Request("http://localhost/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec }) }));
    const answer = await res.json();
    // the ledger's seconds are the fake's own timing
    const { ledger, ...rest } = answer;
    expect(ledger.length).toBeGreaterThan(0);
    expect(sha(sent)).toBe(request);
    expect(sha(rest)).toBe(reply);
  });
});
