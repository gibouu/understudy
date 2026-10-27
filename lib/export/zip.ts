/**
 * The download: one zip holding `lerobot/` (the dataset and its QUALITY.md)
 * and `understudy/` (the task spec, program, interview, report and ledger).
 */
import { zipSync, type Zippable } from "fflate";
import { buildLeRobot, type BuildLeRobotOptions, type FileTree } from "@/lib/export/lerobot";
import { buildQualityReport, renderQualityMarkdown, type QualityInput, type QualityMarkdownOptions } from "@/lib/export/quality";
import type { ExportBundle, QualityReport } from "@/lib/export/types";

const encoder = new TextEncoder();

/** Already-compressed formats are stored, everything else deflated. */
const STORED = /\.(parquet|mp4)$/;

/**
 * Rejects names that could escape their folder when unzipped, on any OS:
 * absolute paths, `.` or `..` segments, backslashes, drive letters, controls.
 */
function safeName(name: string): string {
  if (
    !name ||
    name.startsWith("/") ||
    /[\\:\x00-\x1f]/.test(name) ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe file name in export: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * `understudy/` entries: a string or bytes is written as is, anything else as
 * JSON; a key without an extension gets `.json`.
 */
export function understudyFiles(entries: Record<string, unknown>): FileTree {
  const files: FileTree = {};
  for (const [key, value] of Object.entries(entries)) {
    const name = safeName(/\.[a-z0-9]+$/i.test(key) ? key : `${key}.json`);
    files[name] =
      value instanceof Uint8Array
        ? value
        : encoder.encode(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  }
  return files;
}

/** Zip of folder -> files; returns the bytes. */
export function zipTrees(trees: Record<string, FileTree>): Uint8Array {
  const zippable: Zippable = {};
  for (const [folder, files] of Object.entries(trees)) {
    for (const [path, bytes] of Object.entries(files)) {
      zippable[`${safeName(folder)}/${safeName(path)}`] = [bytes, { level: STORED.test(path) ? 0 : 6 }];
    }
  }
  return zipSync(zippable);
}

/** `rendered` follows from `video`: the quality report says rendered only when the export holds the video. */
export type ExportOptions = BuildLeRobotOptions &
  Omit<QualityInput, "episodes" | "rendered"> &
  Omit<QualityMarkdownOptions, "rendered">;

export type ExportResult = { zip: Uint8Array; paths: string[]; quality: QualityReport };

export async function buildExportZip(bundle: ExportBundle, options: ExportOptions = {}): Promise<ExportResult> {
  const { video, jointUnits, ...qualityInput } = options;
  const { origin } = qualityInput;
  const rendered = Boolean(video);
  const lerobot = await buildLeRobot(bundle.episodes, { video });
  const quality = buildQualityReport({ episodes: bundle.episodes, ...qualityInput, rendered });
  lerobot["QUALITY.md"] = encoder.encode(renderQualityMarkdown(quality, bundle.episodes, { jointUnits, origin, rendered }));
  const understudy = understudyFiles({ ...bundle.understudy, quality });
  const zip = zipTrees({ lerobot, understudy });
  const paths = [
    ...Object.keys(lerobot).map((p) => `lerobot/${p}`),
    ...Object.keys(understudy).map((p) => `understudy/${p}`),
  ].sort();
  return { zip, paths, quality };
}
