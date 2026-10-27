import { describe, expect, it } from "vitest";
import catalog from "@/tests/fixtures/models.json";
import { modelLabel } from "@/lib/providers/models";
import { MODELS } from "@/lib/providers/tokenfactory";

describe("modelLabel", () => {
  it("names every model the app calls, and Nemotron 3.5 Lightning", () => {
    for (const id of [...Object.values(MODELS), "nvidia/Nemotron-3_5-Lightning"]) expect(modelLabel(id)).toMatch(/^Nemotron \d/);
    expect(modelLabel("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")).toBe("Nemotron 3 Nano");
    expect(modelLabel("nvidia/Nemotron-3_5-Lightning")).toBe("Nemotron 3.5 Lightning");
  });

  it("names every NVIDIA model in the price catalogue", () => {
    for (const m of catalog.models.filter((m) => m.id.startsWith("nvidia/"))) expect(modelLabel(m.id), m.id).toMatch(/^Nemotron \d/);
  });

  it("shows an unnamed ID without its owner prefix", () => {
    expect(modelLabel("openai/gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(modelLabel("tavily/search")).toBe("search");
    expect(modelLabel("plain")).toBe("plain");
  });
});
