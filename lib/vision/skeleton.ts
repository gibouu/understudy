/**
 * Draws one token frame on a canvas overlay sized to the sampled frame: the
 * selected person's body (face points left out) and both hands. Landmarks the
 * pose model thinks are hidden are drawn faint; interpolated hands are dashed.
 */
import type { HandTokens, TokenFrame } from "./types";

/** Body connections of the 33-point pose model, without the face. */
const BODY: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

/** The 21-point hand model: wrist, then thumb, index, middle, ring, little finger. */
const HAND: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export const COLOURS = { body: "#f8fafc", left: "#38bdf8", right: "#f97316" };

const VISIBLE = 0.5;

function drawHand(ctx: CanvasRenderingContext2D, hand: HandTokens, colour: string) {
  const { width: w, height: h } = ctx.canvas;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.setLineDash(hand.interpolated ? [4, 4] : []);
  ctx.globalAlpha = hand.interpolated ? 0.6 : 1;
  ctx.beginPath();
  for (const [a, b] of HAND) {
    ctx.moveTo(hand.image[a].x * w, hand.image[a].y * h);
    ctx.lineTo(hand.image[b].x * w, hand.image[b].y * h);
  }
  ctx.stroke();
  for (const p of hand.image) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, frame: TokenFrame | null) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  if (!frame?.pose) return;
  const { image, visibility } = frame.pose;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.strokeStyle = COLOURS.body;
  for (const [a, b] of BODY) {
    ctx.globalAlpha = Math.min(visibility[a], visibility[b]) >= VISIBLE ? 0.9 : 0.25;
    ctx.beginPath();
    ctx.moveTo(image[a].x * w, image[a].y * h);
    ctx.lineTo(image[b].x * w, image[b].y * h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  if (frame.left_hand) drawHand(ctx, frame.left_hand, COLOURS.left);
  if (frame.right_hand) drawHand(ctx, frame.right_hand, COLOURS.right);
}
