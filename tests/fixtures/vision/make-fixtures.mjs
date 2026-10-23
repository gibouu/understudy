// Writes the landmark fixtures for tests/vision/select.test.ts. Synthetic
// people: a 33-point pose built from a torso centre and size, wrists placed by
// hand. Run with `node tests/fixtures/vision/make-fixtures.mjs`.
import { writeFileSync } from "node:fs";

const dir = new URL(".", import.meta.url);
const r = (v) => Math.round(v * 1e4) / 1e4;
const pt = (x, y, z = 0) => ({ x: r(x), y: r(y), z: r(z) });

/** Pose with torso centre (cx, cy), torso height h (frame heights), aspect w/h, wrists given. */
function person(cx, cy, h, aspect, wrists = {}) {
  const half = (0.35 * h) / aspect; // half shoulder width, in normalized x
  const p = Array.from({ length: 33 }, () => pt(cx, cy - 0.7 * h));
  p[11] = pt(cx + half, cy - h / 2); // left shoulder (the person's left, image right)
  p[12] = pt(cx - half, cy - h / 2);
  p[23] = pt(cx + 0.8 * half, cy + h / 2);
  p[24] = pt(cx - 0.8 * half, cy + h / 2);
  p[15] = wrists.left ?? pt(cx + 1.4 * half, cy + 0.2 * h);
  p[16] = wrists.right ?? pt(cx - 1.4 * half, cy + 0.2 * h);
  p[13] = pt((p[11].x + p[15].x) / 2, (p[11].y + p[15].y) / 2);
  p[14] = pt((p[12].x + p[16].x) / 2, (p[12].y + p[16].y) / 2);
  return p;
}

/** 21 hand points with the wrist (point 0) at (x, y), fingers pointing up. */
function hand(x, y) {
  return Array.from({ length: 21 }, (_, i) => pt(x + 0.003 * (i % 5), y - 0.006 * Math.ceil(i / 4), -0.01 * i));
}

const aspect = 16 / 9;
const write = (name, data) => writeFileSync(new URL(name, dir), JSON.stringify(data, null, 1) + "\n");

// Two people and a small figure: the presenter (P) is centred, a larger bystander
// (B) stands at the left edge, a small figure (S) sits behind P near the centre.
// P drifts right; detection order changes every frame; P is missed at frame 6.
{
  const frames = [];
  for (let i = 0; i < 12; i++) {
    const P = person(0.5 + 0.02 * i, 0.55, 0.4, aspect);
    const B = person(0.12, 0.5, 0.5, aspect);
    const S = person(0.47, 0.42, 0.1, aspect);
    const order = [[P, B, S], [B, S, P], [S, P, B]][i % 3];
    const poses = i === 6 ? [B, S] : order;
    frames.push({ t_s: r(i / 10), poses, presenter: i === 6 ? null : poses.indexOf(P) });
  }
  write("two-people.json", { aspect, frames });
}

// The presenter (index 0) and a neighbour (index 1) standing close on the right.
// Hand 0 sits on P's left wrist, hand 1 on P's right wrist, hand 2 is the
// neighbour's left hand reaching near P's left wrist (but nearer its own),
// hand 3 is far from everyone.
{
  const P = person(0.4, 0.55, 0.4, aspect, { left: pt(0.52, 0.62), right: pt(0.3, 0.64) });
  const N = person(0.75, 0.55, 0.4, aspect, { left: pt(0.6, 0.6), right: pt(0.68, 0.66) });
  const hands = [hand(0.522, 0.618), hand(0.302, 0.641), hand(0.598, 0.601), hand(0.05, 0.1)];
  write("hands.json", { aspect, poses: [P, N], hands, expected: { left: 0, right: 1 } });
}

// 10 fps from 0.0 to 2.5 s. Left wrist moves right at 0.1 per second; unseen
// 0.4-0.7 (seen at 0.3 and 0.8: 0.5 s, interpolated) and 1.1-1.9 (seen at 1.0
// and 2.0: 1.0 s, flagged). Right hand unseen 0.0-0.6 at the start (0.7 s,
// flagged) and 2.2-2.5 at the end (0.4 s, left alone).
{
  const frames = [];
  for (let i = 0; i <= 25; i++) {
    const t = r(i / 10);
    const pose = person(0.5, 0.55, 0.4, aspect);
    const leftSeen = !((t >= 0.4 && t <= 0.7) || (t >= 1.1 && t <= 1.9));
    const rightSeen = t >= 0.7 && t <= 2.1;
    const tok = (x, y) => ({ image: hand(x, y), world: hand(x / 10, y / 10), score: 0.9, interpolated: false });
    frames.push({
      t_s: t,
      person_index: 0,
      pose: { image: pose, world: pose.map((p) => pt(p.x / 2, p.y / 2, 0)), visibility: pose.map(() => 0.9) },
      left_hand: leftSeen ? tok(0.2 + 0.1 * t, 0.6) : null,
      right_hand: rightSeen ? tok(0.7, 0.6) : null,
    });
  }
  write("hand-gaps.json", { frames });
}
