// Hand-detection benchmark: runs the /watch page headless on every frame of each
// sample clip (10 fps) and records how many frames got their hands from the full
// frame and how many from a wrist crop.
//
//   BROWSER_PATH=<chromium-based browser binary> node scripts/bench-hands.mjs [base url]
//
// Needs a running dev server (default http://localhost:3011) and `puppeteer-core`
// resolvable from this repo or from PUPPETEER_DIR. Writes bench/results/hands.json.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:3011";
const browserPath = process.env.BROWSER_PATH;
if (!browserPath) throw new Error("Set BROWSER_PATH to a Chrome, Chromium or Edge binary.");
const require = createRequire(path.join(process.env.PUPPETEER_DIR ?? process.cwd(), "package.json"));
const puppeteer = require("puppeteer-core");

const CLIPS = [
  { label: "ISS: seed film", file: "iss-veggie-seed-film" },
  { label: "ISS: chess", file: "dev-clip" },
];

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--use-gl=angle", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const results = [];
try {
  for (const clip of CLIPS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    const failures = [];
    page.on("pageerror", (e) => failures.push(String(e)));
    page.on("response", (r) => {
      if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) failures.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(`${base}/watch`, { waitUntil: "networkidle0", timeout: 120_000 });
    const t0 = Date.now();
    await page.evaluate((label) => [...document.querySelectorAll("button")].find((b) => b.textContent.includes(label)).click(), clip.label);
    await page.waitForFunction(() => document.body.innerText.includes("Watched.") || document.querySelector('[role="alert"]'), { timeout: 600_000, polling: 1000 });
    const text = await page.evaluate(() => document.querySelector("main").innerText);
    const frames = Number((text.match(/frames\n\d+ \/ (\d+)/) ?? [])[1]);
    const cropped = Number((text.match(/zooming on the wrist in (\d+) of/) ?? [])[1]);
    const gaps = text.match(/(left|right) hand, [\d:.]+ to [\d:.]+/g) ?? [];
    results.push({ clip: clip.file, frames, frames_with_crop_hands: cropped, long_hand_gaps: gaps.length, seconds: Math.round((Date.now() - t0) / 1000), failures });
    console.log(`${clip.file}: hands from a wrist crop in ${cropped} of ${frames} frames, ${gaps.length} long gaps, ${failures.length} failures`);
    await page.close();
  }
} finally {
  await browser.close();
}
mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/hands.json", JSON.stringify({ date: new Date().toISOString(), base, fps: 10, results }, null, 2) + "\n");
