/**
 * The export's video, browser-only: one rollout drawn again from the simulator frames the rehearsal kept, on the
 * bare bench (no setting) from the stage's default camera, at 480x360, one picture per dataset frame, handed to
 * the encoder (lib/export/video.ts) as it asks for each, so an episode's pictures are never all held at once.
 * Nothing is simulated here: each picture is the recorded state.
 */
import { StageRenderer } from "@/lib/sim/render";
import type { Frame, SimMeta } from "@/lib/sim/protocol";
import { VIDEO_HEIGHT, VIDEO_WIDTH, type DrawnFrames } from "./video";

/**
 * Pictures of `frames` (already one per dataset frame), drawn on demand. The renderer is made at the first picture
 * and goes after the last, or at `dispose`, whichever comes first.
 */
export function drawFrames(meta: SimMeta, frames: Frame[], { width = VIDEO_WIDTH, height = VIDEO_HEIGHT } = {}): DrawnFrames & { dispose(): void } {
  let stage: { renderer: StageRenderer; box: HTMLDivElement; ctx: CanvasRenderingContext2D; out: HTMLCanvasElement } | null = null;
  const dispose = () => {
    stage?.renderer.dispose({ loseContext: true }); // a context per episode would otherwise outlive the export
    stage?.box.remove();
    stage = null;
  };
  const open = () => {
    // the renderer sizes itself from its canvas's parent: a box of the video's size, off screen
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%";
    box.appendChild(canvas);
    document.body.appendChild(box);
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d");
    if (!ctx) {
      box.remove();
      throw new Error("this browser has no 2D canvas");
    }
    const renderer = new StageRenderer(canvas);
    renderer.setMeta(meta);
    return { renderer, box, ctx, out };
  };
  return {
    length: frames.length,
    dispose,
    async draw(index) {
      stage ??= open();
      stage.renderer.update(frames[index]);
      // read in the same task as the draw: a WebGL canvas is cleared once it is shown
      stage.ctx.drawImage(stage.renderer.draw(), 0, 0, width, height);
      const bitmap = await createImageBitmap(stage.out);
      if (index === frames.length - 1) dispose();
      return bitmap;
    },
  };
}
