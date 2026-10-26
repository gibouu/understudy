/**
 * The recordings /space plays, read from public/showcase at build time.
 * A sample with no recording yet is left out of the gallery.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLES, type Sample } from "@/lib/samples";
import { Session } from "./session";

export type Recorded = { sample: Sample; session: Session };

export async function recording(name: string): Promise<Recorded | null> {
  "use cache";
  const sample = SAMPLES.find((s) => s.name === name);
  if (!sample) return null;
  const text = await readFile(path.join(process.cwd(), "public", "showcase", `${name}.json`), "utf8").catch(() => null);
  return text === null ? null : { sample, session: Session.parse(JSON.parse(text)) };
}

export async function recordings(): Promise<Recorded[]> {
  const all = await Promise.all(SAMPLES.map((s) => recording(s.name)));
  return all.filter((r): r is Recorded => r !== null);
}
