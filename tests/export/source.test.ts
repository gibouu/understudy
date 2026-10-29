/**
 * The export carries the clip's source and licence (#61) and, when the session looked something up, its
 * grounding (#112).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import grounds from "@/tests/fixtures/ground.json";
import { groundingRecord } from "@/lib/export/grounding";
import { clipSource, SAMPLE_SOURCES } from "@/lib/export/source";
import { SAMPLES } from "@/lib/samples";
import { recordings } from "@/lib/showcase/load";
import { tourExport } from "@/lib/showcase/tour";
import type { Grounding } from "@/lib/spec/ground";
import type { StageResult } from "@/lib/spec/stage-result";

const README = readFileSync(path.join(process.cwd(), "samples/README.md"), "utf8");
const row = (name: string) => README.split("\n").find((l) => l.startsWith(`| \`${name}.mp4\``)) ?? "";
const text = (files: Record<string, Uint8Array>, name: string) => new TextDecoder().decode(files[name]);
const trace = Array.from({ length: 30 }, (_, i) => ({ t: i / 30, state: [0, 1, 2, 3, 4, i / 30] as [number, number, number, number, number, number], action: [0, 1, 2, 3, 4, i / 30] as [number, number, number, number, number, number] }));

describe("each sample's source, as samples/README.md has it", () => {
  it("has one for every sample, word for word from its row", () => {
    for (const s of SAMPLES) {
      const src = SAMPLE_SOURCES[s.name];
      const r = row(s.name);
      expect(r, s.name).not.toBe("");
      for (const v of [src.library, src.title, src.url, src.excerpt, src.licence]) expect(r, `${s.name}: ${v}`).toContain(v);
      if (src.nasa_id) expect(r).toContain(`nasa_id \`${src.nasa_id}\`, credit ${src.credit}`);
      else expect(r).toContain(src.credit);
    }
  });

  it("calls any other clip an upload", () => {
    expect(clipSource("my-own-clip")).toBe("upload");
    expect(clipSource("__proto__")).toBe("upload");
  });
});

describe("the ISS clip's export", async () => {
  const all = await recordings();
  const iss = all.find((r) => r.session.clip.name === "iss-veggie-seed-film");

  it("carries the NASA credit verbatim, in QUALITY.md and next to the clip", async () => {
    expect(iss).toBeDefined();
    const { zip, paths } = await tourExport(iss!.session, [{ world: "earth", trace }]);
    const files = unzipSync(zip);
    const quality = text(files, "lerobot/QUALITY.md");
    const nasa_id = "KSC-20250806-MH-NAS01-0001-Veg_03J_Aboard_ISS_iss064m120041018-M15939";
    expect(row("iss-veggie-seed-film")).toContain(`(nasa_id \`${nasa_id}\`, credit NASA)`);
    expect(quality).toContain("## Source");
    expect(quality).toContain(`nasa_id \`${nasa_id}\``);
    expect(quality).toContain("NASA astronaut Mike Hopkins planting Veg-03J aboard ISS");
    expect(quality).toContain("Credit: NASA. Licence: Public domain (work of NASA).");
    const recording = JSON.parse(text(files, "understudy/recording.json"));
    expect(recording.clip.name).toBe("iss-veggie-seed-film");
    expect(recording.source).toMatchObject({ nasa_id, credit: "NASA", licence: "Public domain (work of NASA)", title: "NASA astronaut Mike Hopkins planting Veg-03J aboard ISS" });
    // no lookup in this session: no grounding file
    expect(paths).not.toContain("understudy/grounding.json");
  });

  it("calls a clip of your own an upload", async () => {
    const own = { ...iss!.session, clip: { ...iss!.session.clip, name: "upload-abc" } };
    const files = unzipSync((await tourExport(own, [{ world: "earth", trace }])).zip);
    expect(JSON.parse(text(files, "understudy/recording.json")).source).toBe("upload");
    expect(text(files, "lerobot/QUALITY.md")).toContain('`source: "upload"`');
  });

  it("writes grounding.json, with Tavily's request ids and credits, when the session looked something up", async () => {
    const recorded = (grounds as { result: StageResult<Grounding> }[]).find((g) => g.result.status === "done" && g.result.value.chips.length > 0)!.result;
    const g = groundingRecord(recorded, [0])!;
    const { zip, paths } = await tourExport(iss!.session, [{ world: "earth", trace }], g);
    expect(paths).toContain("understudy/grounding.json");
    const written = JSON.parse(text(unzipSync(zip), "understudy/grounding.json"));
    expect(written.query).toBe((recorded as Extract<StageResult<Grounding>, { status: "done" }>).value.query);
    expect(written.chips[0].added).toBe(true);
    expect(written.chips.slice(1).every((c: { added: boolean }) => !c.added)).toBe(true);
    const tavily = (recorded as { ledger?: { model: string; request_id?: string; credits?: number }[] }).ledger?.filter((e) => e.model.startsWith("tavily/")) ?? [];
    expect(written.tavily).toEqual(tavily.map((e) => expect.objectContaining({ call: e.model, request_id: e.request_id ?? null, credits: e.credits ?? null })));
    expect(groundingRecord({ status: "idle" }, [])).toBeNull();
  });
});
