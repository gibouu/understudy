/**
 * Measurements: how manipulation physics changes with gravity and with motion.
 *
 * Each `it` computes its numbers in MuJoCo (WebAssembly, in Node), asserts
 * the physical invariants that must hold, prints a markdown table and, with
 * MEASURE_WRITE=1, writes bench/results/gravity-<name>.json.
 *
 *   MEASURE_WRITE=1 node_modules/.bin/vitest run tests/measure/gravity.test.ts --reporter=verbose
 *
 * Gravity presets: Earth 1 g, Mars 0.379 g, Moon 0.1654 g, orbit 0 g
 * (1 g = 9.81 m/s²). "In motion" is an accelerating frame, modelled as a
 * gravity vector with a lateral component (see gravity-harness.ts). Objects
 * are placed and let go; no arm is simulated.
 *
 * One rule explains most of what follows: an object released from rest,
 * moved only by gravity and rigid contacts with friction, follows the same
 * path under any gravity above zero; gravity only sets the clock (times scale
 * as 1/sqrt(g)). Gravity changes outcomes through whatever does not scale
 * with it: a residual hand-off velocity, a scripted motion of fixed duration,
 * a frame acceleration, and, in the simulator, the contact softness (MuJoCo's
 * fixed 20 ms time constant). At 0 g nothing moves that was not pushed.
 */
import { describe, expect, it } from "vitest";
import type { MainModule } from "@mujoco/mujoco";
import {
  type ContactModel,
  CUP,
  cupGeoms,
  cylinderLowestZ,
  fmt,
  freeState,
  GRAVITIES,
  gravityVec,
  loadMujoco,
  mdTable,
  norm,
  particleBodies,
  particleStates,
  PARTICLES,
  pocketState,
  pointSpeed,
  rackScene,
  SEATED,
  setFreeVel,
  type Sim,
  sub,
  tiltDeg,
  TUBE,
  tubeBody,
  withSim,
  worldXml,
  writeResults,
  type Vec3,
} from "./gravity-harness";

const MM = 0.001;
/** a body is at rest when no point of it moves faster than this */
const REST_MM_S = 1;
/** particle scenes use the CG solver: about four times faster than Newton with 80 spheres, same pour times (checked) */
const PARTICLE_OPTION = 'solver="CG"';
const print = (title: string, body: string) => console.log(`\n### ${title}\n\n${body}\n`);
const steps = (sim: Sim, seconds: number) => Math.round(seconds / sim.dt);
const horiz = (a: Vec3) => Math.hypot(a[0], a[1]);
/** "-0.0" reads as an error in a table; soft contacts sink a body a few hundredths of a mm */
const mm1 = (x: number) => `${fmt(Math.abs(x) < 0.05 ? 0 : x)} mm`;

describe("gravity measurements", () => {
  it("release-drift: a tube let go with a small residual velocity", async () => {
    const mj = await loadMujoco();
    const speeds_mm_s = [0, 2, 5];
    const T = 2;
    const gap_mm = 0.5;
    const rows: { gravity: string; g: number; v0_mm_s: number; horizontal_mm: number; lowest_above_surface_mm: number; speed_mm_s: number; tilt_deg: number; state: string }[] = [];
    for (const G of GRAVITIES) {
      for (const v0 of speeds_mm_s) {
        const start: Vec3 = [0, 0, TUBE.half_m + gap_mm * MM];
        withSim(mj, worldXml(tubeBody("tube", start), gravityVec(G.g)), (sim) => {
          const adr = sim.free("tube");
          setFreeVel(sim, adr, [v0 * MM, 0, 0]);
          sim.step(steps(sim, T));
          const s = freeState(sim, adr);
          const lowest = cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) / MM;
          const speed = pointSpeed(s, TUBE.half_m) / MM;
          const state =
            speed < REST_MM_S && lowest < 0.2 ? "resting on the surface" : speed < REST_MM_S ? `hovering ${fmt(lowest)} mm above, still` : `moving at ${fmt(speed)} mm/s, ${fmt(lowest)} mm above`;
          rows.push({ gravity: G.label, g: G.g, v0_mm_s: v0, horizontal_mm: horiz(sub(s.pos, start)) / MM, lowest_above_surface_mm: lowest, speed_mm_s: speed, tilt_deg: tiltDeg(s.quat), state });
        });
      }
    }
    print(
      `release-drift: 17 x 100 mm tube released upright ${gap_mm} mm above a flat surface with a horizontal residual velocity; after ${T} s`,
      mdTable(
        ["gravity", "residual velocity", "horizontal drift after 2 s", "end state"],
        rows.map((r) => [r.gravity, `${r.v0_mm_s} mm/s`, `${fmt(r.horizontal_mm, 2)} mm`, r.state]),
      ),
    );
    writeResults("release-drift", {
      parameters: { tube_mm: [17, 100], friction: TUBE.friction, release_gap_above_surface_mm: gap_mm, residual_velocity_direction: "+x (horizontal)", residual_speeds_mm_s: speeds_mm_s, duration_s: T, rest_threshold_mm_s: REST_MM_S },
      results: rows,
    });
    for (const r of rows) {
      if (r.g > 0) {
        // it lands within milliseconds and friction stops a mm/s slide within a fraction of a mm
        expect(r.horizontal_mm).toBeLessThan(0.5);
        expect(r.state).toBe("resting on the surface");
        expect(r.tilt_deg).toBeLessThan(1);
      } else {
        expect(r.horizontal_mm).toBeCloseTo(r.v0_mm_s * T, 2); // v x t: nothing slows it
        expect(r.speed_mm_s).toBeCloseTo(r.v0_mm_s, 3);
        expect(r.lowest_above_surface_mm).toBeCloseTo(gap_mm, 3); // never touches the surface
      }
    }
    // the drift that does happen on a surface grows as gravity falls (it lands later)
    const drift = (g: number) => rows.find((r) => r.g === g && r.v0_mm_s === 5)!.horizontal_mm;
    expect(drift(0.1654)).toBeGreaterThan(drift(1));
  }, 20_000);

  it("early release at the slot mouth vs hold until seated", async () => {
    const mj = await loadMujoco();
    const T = 3;
    const cases = [
      { id: "early", label: "let go at the slot mouth (bottom 30 mm above the pocket floor, 2 mm inside the entrance)", above_mm: 30 },
      { id: "seated", label: "held until seated, then let go", above_mm: 0 },
    ];
    const rows: { gravity: string; g: number; release: string; lowest_above_floor_mm: number; tilt_deg: number; seated: boolean; seated_after_s: number | null }[] = [];
    let geometry = {};
    for (const G of GRAVITIES) {
      for (const c of cases) {
        const scene = rackScene(c.above_mm);
        geometry = { pocket_inner_mm: scene.inner_mm, pocket_depth_mm: scene.depth_mm, pocket_floor_z_mm: scene.floor_mm, rack_top_z_mm: scene.top_mm };
        withSim(mj, worldXml(scene.worldbody, gravityVec(G.g)), (sim) => {
          const floorZ = sim.sitePos(scene.pocketFloorSite)[2];
          expect(floorZ / MM).toBeCloseTo(scene.floor_mm, 6);
          const adr = sim.free(scene.tube);
          let lastUnseated = 0;
          for (let k = 1; k <= steps(sim, T); k++) {
            sim.step();
            const s = freeState(sim, adr);
            const p = pocketState(s, floorZ, scene.pocket_xy_m, scene.inner_mm);
            if (!p.seated) lastUnseated = k * sim.dt;
          }
          const p = pocketState(freeState(sim, adr), floorZ, scene.pocket_xy_m, scene.inner_mm);
          rows.push({ gravity: G.label, g: G.g, release: c.id, lowest_above_floor_mm: p.lowest_above_floor_mm, tilt_deg: p.tilt_deg, seated: p.seated, seated_after_s: p.seated ? lastUnseated : null });
        });
      }
    }
    print(
      `early release vs hold-until-seated: demo rack pocket (20 x 20 mm opening, 32 mm deep), 17 mm tube, after ${T} s; seated = lowest point within ${SEATED.floor_mm} mm of the pocket floor and axis within ${SEATED.tilt_deg} deg of vertical`,
      mdTable(
        ["gravity", "release", "bottom above pocket floor at 3 s", "tilt", "seated", "seated (for good) from"],
        rows.map((r) => [
          r.gravity,
          cases.find((c) => c.id === r.release)!.label,
          mm1(r.lowest_above_floor_mm),
          `${fmt(r.tilt_deg)} deg`,
          r.seated ? "yes" : "no",
          r.seated_after_s === null ? "never" : `${fmt(r.seated_after_s, 3)} s`,
        ]),
      ),
    );
    writeResults("early-release", { parameters: { ...geometry, tube_mm: [17, 100], duration_s: T, cases, seated: SEATED, seated_from: "time after which the seated test holds to the end" }, results: rows });
    const get = (g: number, id: string) => rows.find((r) => r.g === g && r.release === id)!;
    for (const G of GRAVITIES) {
      expect(get(G.g, "seated").seated).toBe(true); // held until seated: seated everywhere
      if (G.g > 0) expect(get(G.g, "early").seated).toBe(true);
    }
    expect(get(0, "early").seated).toBe(false);
    expect(get(0, "early").lowest_above_floor_mm).toBeCloseTo(30, 1); // floats where it was let go
    // same path, slower clock: the 30 mm fall takes sqrt(2h/g)
    for (const G of GRAVITIES.filter((x) => x.g > 0)) expect(get(G.g, "early").seated_after_s!).toBeCloseTo(Math.sqrt((2 * 0.03) / (9.81 * G.g)), 1);
  }, 20_000);

  it("pocket tolerance: lateral offset at release vs seating", async () => {
    const mj = await loadMujoco();
    const T = 3;
    const offsets_mm = Array.from({ length: 17 }, (_, i) => i / 2); // 0 to 8 mm in 0.5 mm steps
    const above_entrance_mm = 5;
    const contacts: ContactModel[] = ["default", "stiff"];
    type Row = { gravity: string; g: number; contacts: ContactModel; offset_mm: number; lowest_above_floor_mm: number; tilt_deg: number; in_pocket: boolean; seated: boolean };
    const rows: Row[] = [];
    const depth = rackScene(0).depth_mm;
    for (const contact of contacts) {
      for (const G of GRAVITIES) {
        for (const dx of offsets_mm) {
          const scene = rackScene(depth + above_entrance_mm, dx);
          withSim(mj, worldXml(scene.worldbody, gravityVec(G.g), { contacts: contact }), (sim) => {
            const floorZ = sim.sitePos(scene.pocketFloorSite)[2];
            const adr = sim.free(scene.tube);
            sim.step(steps(sim, T));
            const p = pocketState(freeState(sim, adr), floorZ, scene.pocket_xy_m, scene.inner_mm);
            rows.push({ gravity: G.label, g: G.g, contacts: contact, offset_mm: dx, lowest_above_floor_mm: p.lowest_above_floor_mm, tilt_deg: p.tilt_deg, in_pocket: p.in_pocket, seated: p.seated });
          });
        }
      }
    }
    const pick = (contact: ContactModel, g: number) => rows.filter((r) => r.contacts === contact && r.g === g);
    const largestSeated = (mine: Row[]) => {
      let k = -1;
      while (k + 1 < mine.length && mine[k + 1].seated) k++;
      return k < 0 ? null : mine[k].offset_mm;
    };
    const summary = GRAVITIES.map((G) => ({
      gravity: G.label,
      g: G.g,
      largest_seated_offset_mm: Object.fromEntries(contacts.map((c) => [c, largestSeated(pick(c, G.g))])) as Record<ContactModel, number | null>,
    }));
    const cell = (r: Row) =>
      r.seated ? "seated" : r.in_pocket ? `in, leaning ${fmt(r.tilt_deg)} deg` : r.lowest_above_floor_mm > depth ? "floats above" : `toppled out (tilt ${fmt(r.tilt_deg, 0)} deg)`;
    const show = (v: number | null) => (v === null ? "none" : `${v} mm`);
    print(
      `pocket tolerance: tube released upright ${above_entrance_mm} mm above the pocket entrance, offset along x; clearance 3 mm (20 mm opening, 17 mm tube, so 1.5 mm free play per side); after ${T} s; MuJoCo default (soft) contacts`,
      mdTable(
        ["offset", ...GRAVITIES.map((G) => G.label)],
        offsets_mm.filter((dx) => Number.isInteger(dx)).map((dx) => [`${dx} mm`, ...GRAVITIES.map((G) => cell(pick("default", G.g).find((r) => r.offset_mm === dx)!))]),
      ) +
        "\n\nLargest offset that seats, with every smaller offset seating too (0.5 mm steps):\n\n" +
        mdTable(
          ["gravity", "default soft contacts (solref 20 ms)", "stiff contacts (solref 4 ms, closer to a rigid rim)"],
          summary.map((s) => [s.gravity, show(s.largest_seated_offset_mm.default), show(s.largest_seated_offset_mm.stiff)]),
        ),
    );
    writeResults("pocket-tolerance", {
      parameters: {
        clearance_mm: 3,
        pocket_inner_mm: [20, 20],
        pocket_depth_mm: depth,
        tube_mm: [17, 100],
        release_above_entrance_mm: above_entrance_mm,
        offsets_mm,
        offset_axis: "x",
        duration_s: T,
        seated: SEATED,
        friction_tube_and_rack: "1 0.005 0.0001",
        contacts: { default: "MuJoCo default solref 0.02 1", stiff: "solref 0.004 1 (2 x timestep)" },
      },
      results: rows,
      summary,
    });
    for (const contact of contacts) {
      for (const G of GRAVITIES) {
        const mine = pick(contact, G.g);
        if (G.g > 0) {
          // inside the free play (offset <= 1.5 mm) the tube drops straight in, under any gravity and contact model
          for (const r of mine.filter((x) => x.offset_mm <= 1.5)) expect(r.seated).toBe(true);
          // at 8 mm the bottom overlaps the rim by 6.5 mm: it never seats
          expect(mine.find((x) => x.offset_mm === 8)!.seated).toBe(false);
        } else {
          // in orbit nothing pulls it in: it stays where it was let go
          for (const r of mine) {
            expect(r.in_pocket).toBe(false);
            expect(r.lowest_above_floor_mm).toBeCloseTo(depth + above_entrance_mm, 1);
          }
        }
      }
    }
    // with near-rigid contacts gravity does not change the outcome: the path is the same, only slower
    const stiff = summary.filter((s) => s.g > 0).map((s) => s.largest_seated_offset_mm.stiff);
    expect(new Set(stiff).size).toBe(1);
  }, 30_000);

  it("pour: 80 water-density spheres from a tilted cup into a lower cup", async () => {
    const mj = await loadMujoco();
    const W = CUP.wall_m;
    const IN = CUP.inner_half_m;
    const H = CUP.height_m;
    const SRC_RIM = 0.1; // source rim height above the table
    const pivot: Vec3 = [IN + W, 0, SRC_RIM]; // outer top edge of the source cup on the pour side
    // centre 80 mm from the source centre, rim 60 mm below the source rim; 10 mm walls so fast particles cannot tunnel through
    const TGT = { x: 0.08, inner_half: 0.03, rim: 0.04, wall: 0.01 };
    const SETTLE = 1;
    const TILT_S = 1.5;
    const TILT_DEG = 120;
    const MEASURE_S = 3;
    const HORIZON_S = 8;
    const STOP_MM_S = [5, 1];
    const tilt = (t: number) => (t <= 0 ? 0 : t >= TILT_S ? 1 : (1 - Math.cos((Math.PI * t) / TILT_S)) / 2) * TILT_DEG * (Math.PI / 180);
    const tiltRate = (t: number) => (t <= 0 || t >= TILT_S ? 0 : ((Math.PI / (2 * TILT_S)) * Math.sin((Math.PI * t) / TILT_S)) * TILT_DEG * (Math.PI / 180));
    const source = `<body name="src" pos="${pivot.join(" ")}">
      <joint name="tilt" type="hinge" axis="0 1 0" armature="100"/>
      ${cupGeoms("src", [IN, IN], H, W, "lip")}
    </body>`;
    const target = `<body name="tgt" pos="${TGT.x} 0 ${TGT.wall}">
      ${cupGeoms("tgt", [TGT.inner_half, TGT.inner_half], TGT.rim - TGT.wall, TGT.wall, "floor")}
    </body>`;
    type Counts = { target: number; source: number; out: number };
    type Row = { gravity: string; g: number; seed: number; at_3s: Counts; at_horizon: Counts; t_target_90pct_s: number | null; t_poured_slower_than_s: Record<string, number | null>; poured: number };

    /** one pour; `seed` changes the sub-mm jitter of the starting lattice, which is enough to show what is chaotic */
    const pour = (mj: MainModule, g: number, label: string, seed: number, contact: { condim?: number; friction?: string } = {}): Row => {
      const particles = particleBodies([0, 0, SRC_RIM - H], contact, seed);
      return withSim(mj, worldXml(`${source}\n${target}\n${particles.xml}`, gravityVec(g), { option: PARTICLE_OPTION }), (sim) => {
        const hinge = sim.joint("tilt");
        const adrs = particles.names.map((n) => sim.free(n));
        const where = (pos: Vec3[]) => {
          const theta = (sim.data.qpos as Float64Array)[hinge.q];
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          return pos.map(([x, y, z]) => {
            const px = x - pivot[0];
            const pz = z - pivot[2];
            const lx = c * px - s * pz; // into the cup frame: R_y(-theta)
            const lz = s * px + c * pz;
            if (Math.abs(lx + IN + W) < IN && Math.abs(y) < IN && lz > -H && lz < 0) return "source" as const;
            if (Math.abs(x - TGT.x) < TGT.inner_half && Math.abs(y) < TGT.inner_half && z < TGT.rim + 0.01) return "target" as const;
            return "out" as const;
          });
        };
        const count = (w: string[]): Counts => ({ target: w.filter((x) => x === "target").length, source: w.filter((x) => x === "source").length, out: w.filter((x) => x === "out").length });
        const drive = (t: number) => {
          (sim.data.qpos as Float64Array)[hinge.q] = tilt(t);
          (sim.data.qvel as Float64Array)[hinge.d] = tiltRate(t);
        };
        // settle in the upright cup, then pour; the clock starts with the tilt
        for (let k = 0; k < steps(sim, SETTLE); k++) {
          drive(0);
          sim.step();
        }
        const lastFaster = STOP_MM_S.map(() => new Array<number>(adrs.length).fill(0));
        let tTarget90: number | null = null;
        let at3: Counts = { target: 0, source: 0, out: 0 };
        const n = steps(sim, HORIZON_S);
        for (let k = 1; k <= n; k++) {
          const t = k * sim.dt;
          drive(t - sim.dt);
          sim.step();
          const st = particleStates(sim, adrs);
          for (let i = 0; i < adrs.length; i++) STOP_MM_S.forEach((v, j) => st.speed[i] / MM >= v && (lastFaster[j][i] = t));
          if (k % 5 === 0 || k === steps(sim, MEASURE_S)) {
            const c = count(where(st.pos));
            if (tTarget90 === null && c.target >= 0.9 * adrs.length) tTarget90 = t;
            if (k === steps(sim, MEASURE_S)) at3 = c;
          }
        }
        const final = where(particleStates(sim, adrs).pos);
        const pouredIdx = final.map((w, i) => (w === "source" ? -1 : i)).filter((i) => i >= 0);
        const p90 = (last: number[]) => {
          const sorted = pouredIdx.map((i) => last[i]).sort((a, b) => a - b);
          const v = sorted.length ? sorted[Math.ceil(0.9 * sorted.length) - 1] : null;
          return v !== null && v < HORIZON_S - 0.01 ? v : null;
        };
        return {
          gravity: label,
          g,
          seed,
          at_3s: at3,
          at_horizon: count(final),
          t_target_90pct_s: tTarget90,
          t_poured_slower_than_s: Object.fromEntries(STOP_MM_S.map((v, j) => [`${v}_mm_s`, p90(lastFaster[j])])),
          poured: pouredIdx.length,
        };
      });
    };

    const SEEDS = [1, 2, 3];
    const rows = GRAVITIES.flatMap((G) => SEEDS.map((seed) => pour(mj, G.g, G.label, seed)));
    // cross-check with frictional spheres (condim 3, friction 0.3) on the three gravities that pour
    const cross = GRAVITIES.filter((G) => G.g > 0).map((G) => pour(mj, G.g, G.label, 1, { condim: 3, friction: "0.3 0.005 0.0001" }));
    const pct = (k: number) => `${Math.round((100 * k) / PARTICLES.count)}%`;
    const time = (t: number | null) => (t === null ? "-" : fmt(t, 2));
    const per = (rs: Row[], f: (r: Row) => string) => rs.map(f).join(" / ");
    const table = (rs: Row[]) =>
      mdTable(
        ["gravity", `in target at ${MEASURE_S} s`, "still in source", "out of both", "90% in target by (s)", "90% of poured < 5 mm/s by (s)", "90% of poured < 1 mm/s by (s)"],
        GRAVITIES.filter((G) => rs.some((r) => r.g === G.g)).map((G) => {
          const mine = rs.filter((r) => r.g === G.g);
          return [
            G.label,
            per(mine, (r) => pct(r.at_3s.target)),
            per(mine, (r) => pct(r.at_3s.source)),
            per(mine, (r) => pct(r.at_3s.out)),
            per(mine, (r) => time(r.t_target_90pct_s)),
            per(mine, (r) => time(r.t_poured_slower_than_s["5_mm_s"])),
            per(mine, (r) => time(r.t_poured_slower_than_s["1_mm_s"])),
          ];
        }),
      );
    print(
      `pour: ${PARTICLES.count} spheres (r ${PARTICLES.radius_m / MM} mm, water density, frictionless, condim 1) in a 40 x 40 x 50 mm cup, tilted ${TILT_DEG} deg about its lip over ${TILT_S} s (cosine ease, then held) toward a 60 x 60 mm cup whose centre is 80 mm away and whose rim is 60 mm lower; times from the start of the tilt; each cell is seed ${SEEDS.join(" / ")} (sub-mm jitter of the starting lattice); "-" = not within ${HORIZON_S} s`,
      table(rows) + "\n\nCross-check, frictional spheres (condim 3, friction 0.3), seed 1:\n\n" + table(cross),
    );
    writeResults("pour", {
      parameters: {
        particles: { ...PARTICLES, note: "condim 1 = frictionless contacts, a low-friction liquid stand-in" },
        cross_check_particles: { condim: 3, friction: "0.3 0.005 0.0001" },
        solver: "CG",
        source_cup: { inner_mm: [40, 40, 50], wall_mm: W / MM, rim_z_mm: SRC_RIM / MM, pivot: "outer top edge on the pour side", tilt_deg: TILT_DEG, tilt_s: TILT_S, profile: "cosine ease, then held", settle_before_tilt_s: SETTLE },
        target_cup: { inner_mm: [60, 60, (TGT.rim - TGT.wall) / MM], wall_mm: TGT.wall / MM, centre_x_mm: TGT.x / MM, rim_z_mm: TGT.rim / MM },
        measure_at_s: MEASURE_S,
        horizon_s: HORIZON_S,
        seeds: SEEDS,
        stop_thresholds_mm_s: STOP_MM_S,
      },
      results: rows,
      cross_check: cross,
    });
    for (const r of [...rows, ...cross]) {
      if (r.g > 0) {
        expect(r.at_3s.target).toBeGreaterThanOrEqual(0.9 * PARTICLES.count);
        expect(r.at_3s.source).toBe(0);
      } else {
        expect(r.at_3s.target).toBe(0); // nothing falls: the particles float
        expect(r.at_horizon.target).toBe(0);
      }
    }
    const t90 = (rs: Row[], g: number) => rs.filter((r) => r.g === g).map((r) => r.t_target_90pct_s!);
    for (const rs of [rows, cross]) {
      expect(Math.min(...t90(rs, 0.379))).toBeGreaterThan(Math.max(...t90(rs, 1))); // lower gravity pours slower
      expect(Math.min(...t90(rs, 0.1654))).toBeGreaterThan(Math.max(...t90(rs, 0.379)));
    }
    // the pour time does not hinge on the seed or the contact model
    for (const G of GRAVITIES.filter((x) => x.g > 0)) {
      const all = [...t90(rows, G.g), ...t90(cross, G.g)];
      expect(Math.max(...all) - Math.min(...all)).toBeLessThan(0.15);
    }
  }, 40_000);

  it("settle time: a tube dropped upright from 20 mm onto a flat surface", async () => {
    const mj = await loadMujoco();
    const DROP_MM = 20;
    const HORIZON_S = 10;
    const rows: { gravity: string; g: number; free_fall_s: number | null; first_contact_s: number | null; settle_s: number | null; after_contact_s: number | null; final_tilt_deg: number }[] = [];
    for (const G of GRAVITIES) {
      withSim(mj, worldXml(tubeBody("tube", [0, 0, TUBE.half_m + DROP_MM * MM]), gravityVec(G.g)), (sim) => {
        const adr = sim.free("tube");
        let firstContact: number | null = null;
        let lastNotResting = 0;
        let tilt = 0;
        const n = steps(sim, HORIZON_S);
        for (let k = 1; k <= n; k++) {
          sim.step();
          const s = freeState(sim, adr);
          const lowest = cylinderLowestZ(s, TUBE.radius_m, TUBE.half_m) / MM;
          if (firstContact === null && lowest <= 0) firstContact = k * sim.dt;
          const resting = lowest < 0.5 && pointSpeed(s, TUBE.half_m) / MM < REST_MM_S;
          if (!resting) lastNotResting = k * sim.dt;
          tilt = tiltDeg(s.quat);
        }
        const settle = lastNotResting < HORIZON_S - sim.dt / 2 ? lastNotResting : null;
        rows.push({
          gravity: G.label,
          g: G.g,
          free_fall_s: G.g > 0 ? Math.sqrt((2 * DROP_MM * MM) / (9.81 * G.g)) : null,
          first_contact_s: firstContact,
          settle_s: settle,
          after_contact_s: settle !== null && firstContact !== null ? settle - firstContact : null,
          final_tilt_deg: tilt,
        });
      });
    }
    print(
      `settle time: 17 x 100 mm tube dropped upright from ${DROP_MM} mm onto a flat surface; at rest = every point slower than ${REST_MM_S} mm/s while touching, for the rest of ${HORIZON_S} s`,
      mdTable(
        ["gravity", "free fall (theory)", "first contact", "at rest after", "of which after contact", "final tilt"],
        rows.map((r) => [
          r.gravity,
          r.free_fall_s === null ? "never falls" : `${fmt(r.free_fall_s, 3)} s`,
          r.first_contact_s === null ? "never" : `${fmt(r.first_contact_s, 3)} s`,
          r.settle_s === null ? `not within ${HORIZON_S} s` : `${fmt(r.settle_s, 3)} s`,
          r.after_contact_s === null ? "-" : `${fmt(r.after_contact_s, 3)} s`,
          `${fmt(r.final_tilt_deg)} deg`,
        ]),
      ),
    );
    writeResults("settle-time", { parameters: { tube_mm: [17, 100], drop_height_mm: DROP_MM, horizon_s: HORIZON_S, rest_threshold_mm_s: REST_MM_S, rest_requires_contact: "lowest point < 0.5 mm above the surface", contacts: "MuJoCo default solref 0.02 1" }, results: rows });
    for (const r of rows) {
      if (r.g > 0) {
        expect(r.settle_s).not.toBeNull();
        expect(r.first_contact_s!).toBeCloseTo(r.free_fall_s!, 1);
        expect(r.final_tilt_deg).toBeLessThan(1); // lands on its base and stays upright
      } else {
        expect(r.first_contact_s).toBeNull();
        expect(r.settle_s).toBeNull();
      }
    }
    const settle = (g: number) => rows.find((r) => r.g === g)!.settle_s!;
    expect(settle(0.1654)).toBeGreaterThan(settle(0.379));
    expect(settle(0.379)).toBeGreaterThan(settle(1));
  }, 20_000);

  it("motion: a seated tube, a standing tube and a cup of particles in an accelerating frame", async () => {
    const mj = await loadMujoco();
    const T = 3;
    const conditions: { id: string; label: string; base: Vec3; moving: Vec3 }[] = [
      { id: "earth-0.05g", label: "Earth, vehicle accelerating at 0.05 g", base: gravityVec(1), moving: gravityVec(1, 0.05) },
      { id: "earth-0.2g", label: "Earth, vehicle accelerating at 0.2 g", base: gravityVec(1), moving: gravityVec(1, 0.2) },
      { id: "orbit-0.02g", label: "orbit, 0.02 g thrust sideways", base: gravityVec(0), moving: gravityVec(0, 0.02) },
      // extra: the same thrust along the cup's axis, accelerating toward the cup's base, pulls contents out of the mouth
      { id: "orbit-0.02g-axial", label: "orbit, 0.02 g thrust toward the cup's base (extra)", base: gravityVec(0), moving: gravityVec(-0.02) },
    ];
    const W = CUP.wall_m;
    const IN = CUP.inner_half_m;
    // the pour cup (50 mm deep) and a near-full one: the same 80 particles in a 25 mm deep cup
    const CUP_DEPTHS_MM = [50, 25];
    const particles = particleBodies([0, 0, W]);
    type CupResult = { depth_mm: number; out_at_end: number; ever_out: number; fill_height_mm: number };
    type Row = {
      condition: string;
      gravity_m_s2: Vec3;
      pocket_tube: { seated: boolean; in_pocket: boolean; max_tilt_deg: number; end_tilt_deg: number; end_above_floor_mm: number };
      standing_tube: { max_tilt_deg: number; end_tilt_deg: number; moved_mm: number };
      cups: CupResult[];
    };
    const rows: Row[] = [];
    for (const c of conditions) {
      // the acceleration starts as a step after 0.5 s (tubes) or 1 s (particles) of settling under the base gravity
      const scene = rackScene(0);
      const pocketTube = withSim(mj, worldXml(scene.worldbody, c.base), (sim) => {
        const floorZ = sim.sitePos(scene.pocketFloorSite)[2];
        const adr = sim.free(scene.tube);
        sim.step(steps(sim, 0.5));
        sim.setGravity(c.moving);
        let maxTilt = 0;
        for (let k = 0; k < steps(sim, T); k++) {
          sim.step();
          maxTilt = Math.max(maxTilt, tiltDeg(freeState(sim, adr).quat));
        }
        const p = pocketState(freeState(sim, adr), floorZ, scene.pocket_xy_m, scene.inner_mm);
        return { seated: p.seated, in_pocket: p.in_pocket, max_tilt_deg: maxTilt, end_tilt_deg: p.tilt_deg, end_above_floor_mm: p.lowest_above_floor_mm };
      });
      const standingTube = withSim(mj, worldXml(tubeBody("tube", [0, 0, TUBE.half_m]), c.base), (sim) => {
        const adr = sim.free("tube");
        sim.step(steps(sim, 0.5));
        const start = freeState(sim, adr).pos;
        sim.setGravity(c.moving);
        let maxTilt = 0;
        for (let k = 0; k < steps(sim, T); k++) {
          sim.step();
          maxTilt = Math.max(maxTilt, tiltDeg(freeState(sim, adr).quat));
        }
        const s = freeState(sim, adr);
        return { max_tilt_deg: maxTilt, end_tilt_deg: tiltDeg(s.quat), moved_mm: norm(sub(s.pos, start)) / MM };
      });
      const cups = CUP_DEPTHS_MM.map((depth_mm): CupResult => {
        const H = depth_mm * MM;
        const cup = `<body name="cup" pos="0 0 ${W}">
      ${cupGeoms("cup", [IN, IN], H, W, "floor")}
    </body>`;
        const inCup = ([x, y, z]: Vec3) => Math.abs(x) < IN && Math.abs(y) < IN && z > W && z < W + H;
        return withSim(mj, worldXml(`${cup}\n${particles.xml}`, c.base, { option: PARTICLE_OPTION }), (sim) => {
          const adrs = particles.names.map((n) => sim.free(n));
          sim.step(steps(sim, 1));
          const settled = particleStates(sim, adrs);
          const fill = (Math.max(...settled.pos.map((p) => p[2])) + PARTICLES.radius_m - W) / MM;
          sim.setGravity(c.moving);
          const ever = new Set<number>();
          for (let k = 0; k < steps(sim, T); k++) {
            sim.step();
            if (k % 5 === 0) particleStates(sim, adrs).pos.forEach((p, i) => !inCup(p) && ever.add(i));
          }
          const end = particleStates(sim, adrs).pos.filter((p) => !inCup(p)).length;
          return { depth_mm, out_at_end: end, ever_out: ever.size, fill_height_mm: fill };
        });
      });
      rows.push({ condition: c.label, gravity_m_s2: c.moving, pocket_tube: pocketTube, standing_tube: standingTube, cups });
    }
    const pocketCell = (p: Row["pocket_tube"]) =>
      p.seated
        ? `yes (max tilt ${fmt(p.max_tilt_deg)} deg)`
        : p.in_pocket
          ? `in the pocket, leaning ${fmt(p.end_tilt_deg)} deg on its walls`
          : `out of the pocket: bottom ${mm1(p.end_above_floor_mm)} above its floor`;
    const standingCell = (s: Row["standing_tube"]) =>
      s.end_tilt_deg > 45 ? `toppled (${fmt(s.end_tilt_deg, 0)} deg)` : s.moved_mm > 5 ? `drifted ${fmt(s.moved_mm, 0)} mm away, still upright` : `upright (max tilt ${fmt(s.max_tilt_deg)} deg)`;
    print(
      `motion: accelerating frame = gravity vector with a lateral component, switched on as a step and held ${T} s; tube in the demo rack pocket; a 17 x 100 mm tube standing free on the table; ${PARTICLES.count} frictionless spheres in an open 40 x 40 mm cup, ${CUP_DEPTHS_MM.join(" or ")} mm deep (settled fill ${fmt(rows[0].cups[0].fill_height_mm, 0)} mm on Earth)`,
      mdTable(
        ["condition", "tube in pocket after 3 s", "free-standing tube after 3 s", ...CUP_DEPTHS_MM.map((d) => `particles out of the ${d} mm cup at 3 s (ever out)`)],
        rows.map((r) => [r.condition, pocketCell(r.pocket_tube), standingCell(r.standing_tube), ...r.cups.map((cp) => `${cp.out_at_end} of ${PARTICLES.count} (${cp.ever_out})`)]),
      ),
    );
    // toppling threshold of the free-standing tube: the lateral acceleration (step onset) that tips it over, by bisection
    const topples = (g: number, a_over_g: number, contacts: ContactModel) =>
      withSim(mj, worldXml(tubeBody("tube", [0, 0, TUBE.half_m]), gravityVec(g), { contacts }), (sim) => {
        const adr = sim.free("tube");
        sim.step(steps(sim, 0.5));
        sim.setGravity(gravityVec(g, a_over_g * g));
        sim.step(steps(sim, 3 / Math.sqrt(g))); // 3 s on Earth, same path on a slower clock elsewhere
        return tiltDeg(freeState(sim, adr).quat) > 45;
      });
    const threshold = (g: number, contacts: ContactModel) => {
      let lo = 0.05;
      let hi = 0.3;
      expect(topples(g, lo, contacts)).toBe(false);
      expect(topples(g, hi, contacts)).toBe(true);
      while (hi - lo > 0.0025) {
        const mid = (lo + hi) / 2;
        if (topples(g, mid, contacts)) hi = mid;
        else lo = mid;
      }
      return (lo + hi) / 2;
    };
    const R_OVER_H = TUBE.radius_m / TUBE.half_m;
    const tipping = GRAVITIES.filter((G) => G.g > 0).map((G) => {
      const stiff = threshold(G.g, "stiff");
      const soft = threshold(G.g, "default");
      return { gravity: G.label, g: G.g, a_over_g_stiff: stiff, a_m_s2_stiff: stiff * G.g * 9.81, a_over_g_default: soft, a_m_s2_default: soft * G.g * 9.81 };
    });
    print(
      `free-standing 17 x 100 mm tube: lateral acceleration (step onset) that topples it; theory for a rigid block: a/g > half-width / centre height = ${fmt(R_OVER_H, 3)}`,
      mdTable(
        ["gravity", "topples above (stiff contacts)", "same, in m/s²", "with default soft contacts"],
        tipping.map((t) => [t.gravity, `${fmt(t.a_over_g_stiff, 3)} x local g`, `${fmt(t.a_m_s2_stiff, 2)} m/s² (${fmt(t.a_m_s2_stiff / 9.81, 3)} Earth g)`, `${fmt(t.a_over_g_default, 3)} x local g`]),
      ) + "\n\nIn orbit there is no threshold: any acceleration moves it.",
    );
    writeResults("motion", {
      tipping,
      parameters: {
        model: "accelerating frame = gravity vector with a lateral component (a frame accelerating at +a along x sees -a along x), applied as a step after settling",
        conditions,
        duration_s: T,
        settle_s: { tubes: 0.5, particles: 1 },
        pocket_tube: { mm: [17, 100], pocket: "demo rack, 20 x 20 mm opening, 32 mm deep", seated: SEATED },
        standing_tube: { mm: [17, 100], friction: TUBE.friction, static_tip_ratio_r_over_h: TUBE.radius_m / TUBE.half_m },
        cups: { inner_mm: [40, 40], depths_mm: CUP_DEPTHS_MM, particles: PARTICLES },
        solver_particles: "CG",
      },
      results: rows,
    });
    // near-rigid contacts reproduce the rigid-block rule at every gravity: the threshold is a fixed fraction of local g
    for (const t of tipping) expect(t.a_over_g_stiff).toBeCloseTo(R_OVER_H, 1);
    expect(Math.max(...tipping.map((t) => t.a_over_g_stiff)) - Math.min(...tipping.map((t) => t.a_over_g_stiff))).toBeLessThan(0.01);
    const get = (id: string) => rows[conditions.findIndex((c) => c.id === id)];
    // a free-standing block tips when a/g exceeds half-width / centre height (8.5 / 50 = 0.17 for this tube)
    expect(get("earth-0.05g").standing_tube.end_tilt_deg).toBeLessThan(1);
    expect(get("earth-0.2g").standing_tube.end_tilt_deg).toBeGreaterThan(45);
    // the pocket holds the tube upright where the free-standing one falls
    expect(get("earth-0.05g").pocket_tube.seated).toBe(true);
    expect(get("earth-0.2g").pocket_tube.seated).toBe(true);
    for (const cp of get("earth-0.05g").cups) expect(cp.ever_out).toBe(0);
    // pulled toward the mouth in orbit, the cup holds nothing
    for (const cp of get("orbit-0.02g-axial").cups) expect(cp.out_at_end).toBe(PARTICLES.count);
    expect(get("orbit-0.02g-axial").pocket_tube.seated).toBe(false);
  }, 40_000);
});
