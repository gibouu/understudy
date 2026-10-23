/**
 * GET /samples/<name>.mp4: the clips under samples/ (dev clip now, gib's three
 * sample clips later). Prerendered at build from the files on disk, so the
 * bytes ship as static assets; the page fetches one into a blob URL.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "samples");

export async function generateStaticParams() {
  const files = await readdir(DIR);
  return files.filter((f) => /^[\w-]+\.mp4$/.test(f)).map((name) => ({ name }));
}

async function clip(name: string): Promise<Uint8Array | null> {
  "use cache";
  if (!/^[\w-]+\.mp4$/.test(name)) return null;
  const bytes = await readFile(path.join(DIR, name)).catch(() => null);
  return bytes && new Uint8Array(bytes);
}

export async function GET(_req: Request, { params }: RouteContext<"/samples/[name]">) {
  const bytes = await clip((await params).name);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "video/mp4" } });
}
