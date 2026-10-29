/**
 * #159: toss and catch run from hand-written programs, but the compile prompt does not offer them. A compiled
 * answer naming one is unusable exactly as an unknown op was before they existed: the route asks again, and with no
 * usable answer and nothing to keep it fails. Token Factory is faked.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Session } from "@/lib/showcase/session";
import { CompiledProgram, PlaybookProgram, Program } from "@/lib/spec/schema";

const sent: { messages: { role: string; content: string }[] }[] = [];
/** how many answers, from the first, carry a toss */
let tossing = 0;
const session = (clip: string) => Session.parse(JSON.parse(readFileSync(path.join(process.cwd(), "public", "showcase", `${clip}.json`), "utf8")));
const PIPETTE = session("iss-glovebox-pipette").iterations[1];

vi.mock("@/lib/providers/tokenfactory", async (original) => {
  const tf = await original<typeof import("@/lib/providers/tokenfactory")>();
  return {
    ...tf,
    wantsReplay: () => false,
    tokenFactory: () => ({
      models: { list: async () => ({ data: Object.values(tf.MODELS).map((id) => ({ id })) }) },
      chat: {
        completions: {
          create: async (args: { messages: { role: string; content: string }[] }) => {
            sent.push({ messages: args.messages.map((m) => ({ ...m })) });
            const program = PIPETTE.program;
            const withToss = { ...program, steps: program.steps.map((s, k) => (k === 0 ? { ...s, ops: [...s.ops, { op: "toss", velocity_mm_s: [0, 0, 1000] }] } : s)) };
            const content = JSON.stringify(sent.length <= tossing ? withToss : program);
            return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
          },
        },
      },
    }),
  };
});

async function post(spec: unknown) {
  const { POST } = await import("@/app/api/compile/route");
  sent.length = 0;
  const res = await POST(new Request("http://localhost/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec }) }));
  return res.json();
}

describe("toss and catch are not compile ops (#159)", () => {
  const toss = { spec_title: "t", steps: [{ step_id: "s1", ops: [{ op: "toss", velocity_mm_s: [0, 0, 1000] }] }] };
  const caught = { spec_title: "t", steps: [{ step_id: "s1", ops: [{ op: "catch", object: "a" }] }] };
  const unknown = { spec_title: "t", steps: [{ step_id: "s1", ops: [{ op: "fly" }] }] };

  it("a hand-written program runs them; a compiled answer cannot name them, as it cannot name an unknown op", () => {
    expect(Program.safeParse(toss).success).toBe(true);
    expect(Program.safeParse(caught).success).toBe(true);
    for (const schema of [CompiledProgram, PlaybookProgram]) {
      const issue = (x: unknown) => schema.safeParse(x).error?.issues.map(({ code, path }) => ({ code, path }));
      expect(schema.safeParse(toss).success).toBe(false);
      expect(schema.safeParse(caught).success).toBe(false);
      expect(issue(toss)).toEqual(issue(unknown));
    }
    // the eight compile ops still parse, as before
    expect(CompiledProgram.safeParse(PIPETTE.program).success).toBe(true);
  });

  it("an answer with a toss is unusable: the route asks again and keeps the clean answer", async () => {
    tossing = 1;
    try {
      const r = await post(PIPETTE.spec);
      expect(sent.length).toBe(2);
      expect(sent[1].messages.at(-1)!.content).toContain("That answer was not usable");
      expect(r.status).toBe("done");
      expect(JSON.stringify(r.value)).not.toContain('"toss"');
    } finally {
      tossing = 0;
    }
  });

  it("two answers with a toss and nothing to keep: the compile fails", async () => {
    tossing = 2;
    try {
      const r = await post(PIPETTE.spec);
      expect(sent.length).toBe(2);
      expect(r.status).toBe("failed");
    } finally {
      tossing = 0;
    }
  });
});
