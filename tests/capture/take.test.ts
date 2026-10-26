import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import labels from "@/tests/fixtures/label.json";
import { POST as compile } from "@/app/api/compile/route";
import { POST as label } from "@/app/api/label/route";
import { TAKE_S } from "@/lib/capture/recorder";
import { fitToBench } from "@/lib/sim/fit";
import { Program, TaskSpec } from "@/lib/spec/schema";

// 8 s camera takes recorded by app/capture.tsx in headless Edge 155, from
// Chromium's fake camera playing a stretch of samples/iss-veggie-seed-film.mp4
// (NASA). The MP4 one was labelled and compiled live on 26 Oct 2026.
const take = (name: string) => readFileSync(path.join(process.cwd(), "tests", "fixtures", "take", name));

describe("a camera take, as makeProxy's demuxer reads it", () => {
  it.each([
    ["chromium-take.mp4", "avc"],
    ["chromium-take.webm", "vp8"],
  ])("%s is %s and about 8 s long, though Chrome's WebM states no duration", async (name, codec) => {
    const input = new Input({ source: new BufferSource(take(name)), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    expect(video?.codec).toBe(codec);
    expect(Math.abs((await input.computeDuration()) - TAKE_S)).toBeLessThan(0.5);
  });
});

describe("the take path in replay", () => {
  const sha = createHash("sha256").update(take("chromium-take.mp4")).digest("hex");
  const post = (route: (req: Request) => Promise<Response>, body: unknown) => route(new Request("http://x/api?replay=1", { method: "POST", body: JSON.stringify(body) }));

  it("labels the recorded take from its own recording, then compiles the fitted spec", async () => {
    expect(labels.some((r) => r.clip_sha256 === sha)).toBe(true);
    const labelled = await (await post(label, { clip_sha256: sha })).json();
    expect(labelled.status).toBe("done");
    expect(labelled.warnings).not.toContain("replay: recorded for another clip");
    const spec = TaskSpec.parse(labelled.value);
    expect(spec.provenance?.clip_sha256).toBe(sha);

    const fit = fitToBench(spec);
    const compiled = await (await post(compile, { spec: fit.spec })).json();
    expect(compiled.status).toBe("done");
    expect(Program.parse(compiled.value).spec_title).toBe(spec.title);
  });
});
