/**
 * #56: with the playbook switch off, /api/compile sends Token Factory exactly what it sent before the
 * playbook existed, and answers exactly the same; so it does with the switch on when no rule left on
 * matches the spec. With it on, only the rules of the spec's kind of task are sent. The hashes below were taken from the route on
 * next/after-submit at 0577200, before lib/spec/playbook.ts was written; Token Factory is faked.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Session } from "@/lib/showcase/session";
import { DEFAULT_ON, PLAYBOOK } from "@/lib/spec/playbook";

const sent: unknown[] = [];
let twoDrafts = false;
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
            // with the playbook on, the fake says it applied every rule it was given, and one it was not
            const given = [...args.messages[1].content.matchAll(/^- ([a-z-]+) \(learned on/gm)].map((m) => m[1]);
            const answer = given.length ? { ...program, playbook: [...given, "zone-lift-reach"] } : program;
            // two drafts that differ only in a playbook key: read as one program, as before the playbook
            const content = twoDrafts ? `${JSON.stringify({ ...program, playbook: ["a"] })}\n${JSON.stringify({ ...program, playbook: ["b"] })}` : JSON.stringify(answer);
            return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
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
    for (const playbook of [undefined, { rules: [] }, { rules: ["zone-lift-reach", "pour-tilt-longer"] }, { rules: [...DEFAULT_ON], failure: "spec_gap" }]) {
      const { ledger, ...rest } = await post(session(clip).iterations[i].spec, playbook);
      expect(ledger.length).toBeGreaterThan(0);
      expect(sha(sent), JSON.stringify(playbook)).toBe(request);
      expect(sha(rest), JSON.stringify(playbook)).toBe(reply);
    }
  });
});

async function post(spec: unknown, playbook?: unknown) {
  const { POST } = await import("@/app/api/compile/route");
  sent.length = 0;
  const res = await POST(new Request("http://localhost/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(playbook === undefined ? { spec } : { spec, playbook }) }));
  return res.json();
}

describe("the playbook switch off, an answer with a stray playbook key", () => {
  it("is parsed as before the playbook: one call, the key dropped", async () => {
    twoDrafts = true;
    try {
      const r = await post(session("iss-glovebox-pipette").iterations[1].spec);
      expect(sent.length).toBe(1);
      expect(r.status).toBe("done");
      expect(r.value.playbook).toBeUndefined();
    } finally {
      twoDrafts = false;
    }
  });
});

describe("the playbook switch on", () => {
  it("sends only the rules of the spec's kind of task, and the program cites only those it was given", async () => {
    const spec = session("iss-glovebox-pipette").iterations[1].spec;
    const r = await post(spec, { rules: PLAYBOOK.map((x) => x.id) });
    const user = (sent[0] as { messages: { content: string }[] }).messages[1].content;
    expect(user).toContain("\n\nPlaybook: ");
    expect([...user.matchAll(/^- ([a-z-]+) \(learned on/gm)].map((m) => m[1])).toEqual(["pocket-lift-reach", "pocket-wait-still-orbit", "pocket-release-above-floor"]);
    expect(user).not.toMatch(/zone-|pour-/);
    expect(r.status).toBe("done");
    expect(r.value.playbook).toEqual(["playbook#pocket-lift-reach", "playbook#pocket-wait-still-orbit", "playbook#pocket-release-above-floor"]);
  });

  it("refuses a playbook that is not a list of rule ids", async () => {
    const r = await post(session("iss-glovebox-pipette").iterations[1].spec, { rules: "all" });
    expect(r.status).toBe("failed");
  });
});
