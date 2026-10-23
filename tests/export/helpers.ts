import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EpisodeVideoEncoder } from "@/lib/export/video";
import type { EpisodeRecord } from "@/lib/export/types";

const GROOT = join(__dirname, "..", "fixtures", "groot");

export const grootJson = (name: string) => JSON.parse(readFileSync(join(GROOT, name), "utf8"));
export const grootJsonl = (name: string) =>
  readFileSync(join(GROOT, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const decoder = new TextDecoder();
export const text = (bytes: Uint8Array) => decoder.decode(bytes);
export const parseJson = (bytes: Uint8Array) => JSON.parse(text(bytes));
export const parseJsonl = (bytes: Uint8Array) =>
  text(bytes)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

/** Stands in for the browser encoder: records what it was given, returns a marker. */
export function stubVideoEncoder(): EpisodeVideoEncoder & { calls: number[] } {
  const calls: number[] = [];
  return {
    format: { codec: "h264" },
    width: 480,
    height: 360,
    fps: 15,
    calls,
    async encode(frames) {
      calls.push(frames.length);
      return new TextEncoder().encode(`stub video, ${frames.length} frames`);
    },
  };
}

/** Attaches blank frames so a stub encoder accepts the episodes. */
export function withVideo(episodes: EpisodeRecord[]): EpisodeRecord[] {
  return episodes.map((ep) => ({
    ...ep,
    video: { width: 480, height: 360, frames: ep.frames.map(() => new Blob([])) },
  }));
}

/** Sorted top-level keys of an object. */
export const keys = (o: object) => Object.keys(o).sort();
