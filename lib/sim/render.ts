/**
 * three.js view of the MuJoCo scene. Geometry comes from the model itself
 * (mesh vertices and faces, primitive sizes), poses from each frame.
 * MuJoCo is Z-up; the camera is told so and everything else follows.
 * The liquid, when the scene has one, is one instanced sphere per particle
 * (diameter the particle spacing), tinted from deep blue at rest to pale
 * when it moves fast. A setting (lib/sim/settings.ts) can be drawn around the
 * bench: decoration only, the bench's floor hidden under its work surface.
 * A setting once built is kept until the renderer goes, so going back to it
 * costs nothing.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  GEOM_BOX,
  GEOM_CAPSULE,
  GEOM_CYLINDER,
  GEOM_ELLIPSOID,
  GEOM_MESH,
  GEOM_PLANE,
  GEOM_SPHERE,
  type Frame,
  type GeomMeta,
  type SimMeta,
} from "./protocol";
import type { TaskSpec } from "@/lib/spec/schema";
import { Dressing, SETTING_VIEW, type SettingName } from "./settings";

const ROT_Z_TO_Y = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const STILL = new THREE.Color(0x1d4ed8);
const FAST = new THREE.Color(0xbae6fd);
/** a particle at this speed or faster is drawn FAST, m/s */
const FAST_M_S = 0.5;
const BENCH = new THREE.Color(0xf4f1ea);

export class StageRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private objects = new Map<number, THREE.Object3D>();
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private liquid: THREE.InstancedMesh | null = null;
  /** the previous frame's particles, for their speed */
  private liquidPrev: { positions: Float32Array; t: number } | null = null;
  /** the move_to target */
  private marker = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12), new THREE.MeshBasicMaterial({ color: 0xd9480f }));
  /** the setting drawn around the bench, the ones built so far, and the bench view to go back to */
  private dressing: Dressing | null = null;
  private built = new Map<SettingName, Dressing>();
  private benchView: [THREE.Vector3Tuple, THREE.Vector3Tuple] | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = BENCH;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 20);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0.7, -0.6, 0.45);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0.1, 0, 0.12);
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x998877, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1, 2);
    this.scene.add(sun);
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  private resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Draws the scene now, so the canvas can be read in the same task (the export's video, lib/export/render.ts). */
  draw(): HTMLCanvasElement {
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }

  /** Look at `target` from `from`, world metres; with a setting drawn, also the view the bare bench gets back. */
  view(target: [number, number, number], from: [number, number, number]) {
    if (this.dressing) this.benchView = [target, from];
    this.look(target, from);
  }

  private look(target: [number, number, number], from: [number, number, number]) {
    this.camera.position.set(...from);
    this.controls.target.set(...target);
    this.controls.update();
  }

  /** Where a click at client coordinates meets the floor, world metres; null when the ray misses it. */
  floorPoint(clientX: number, clientY: number): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return hit ? [hit.x, hit.y] : null;
  }

  /** Show the move_to target (world metres); null hides it. */
  setTarget(p: [number, number, number] | null) {
    this.marker.visible = p !== null;
    if (p) this.marker.position.set(...p);
  }

  setMeta(meta: SimMeta) {
    for (const o of this.objects.values()) {
      this.scene.remove(o);
      disposeObject(o);
    }
    this.objects.clear();
    this.setLiquid(meta.liquid);
    const meshById = new Map(meta.meshes.map((m) => [m.id, m]));
    for (const g of meta.geoms) {
      if (g.group >= 3) continue; // collision-only geoms
      const obj = this.buildGeom(g, meshById);
      if (!obj) continue;
      obj.userData.floor = g.type === GEOM_PLANE;
      obj.visible = !(obj.userData.floor && this.dressing);
      this.scene.add(obj);
      this.objects.set(g.id, obj);
    }
  }

  /**
   * Draw a setting around the bench, its room built around the objects of `around` (the spec on the stage), or the
   * bare bench again with null. Visual only: the physics never sees it.
   */
  setSetting(name: SettingName | null, around?: TaskSpec) {
    const was = this.dressing;
    if (was ? was.name === name && was.around === around : !name) return;
    if (was) this.scene.remove(was.group);
    else this.benchView = [this.controls.target.toArray(), this.camera.position.toArray()];
    this.dressing = name ? this.dressingFor(name, around) : null;
    if (this.dressing) this.scene.add(this.dressing.group);
    this.scene.background = this.dressing?.background ?? BENCH;
    for (const o of this.objects.values()) if (o.userData.floor) o.visible = !this.dressing;
    // into a room from the bench: step back so the walls show; back to the bench: the view it had
    if (!was) this.look(...SETTING_VIEW);
    else if (!this.dressing && this.benchView) this.look(...this.benchView);
  }

  /** A setting built around `around`, from the ones already built when it is the same spec. */
  private dressingFor(name: SettingName, around?: TaskSpec): Dressing {
    const kept = this.built.get(name);
    if (kept && kept.around === around) return kept;
    kept?.dispose();
    const fresh = new Dressing(name, around);
    this.built.set(name, fresh);
    return fresh;
  }

  private setLiquid(l: SimMeta["liquid"]) {
    if (this.liquid) {
      this.scene.remove(this.liquid);
      disposeObject(this.liquid);
      this.liquid = null;
    }
    this.liquidPrev = null;
    if (!l || l.particles === 0) return;
    const geo = new THREE.IcosahedronGeometry(l.spacing_m / 2, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0, transparent: true, opacity: 0.85 });
    const mesh = new THREE.InstancedMesh(geo, mat, l.particles);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3 * l.particles), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // the particles move; their bounds are never recomputed
    this.liquid = mesh;
    this.scene.add(mesh);
  }

  private updateLiquid(frame: Frame) {
    const mesh = this.liquid;
    const l = frame.liquid;
    if (!mesh || !l) return;
    const n = Math.min(mesh.count, l.positions.length / 3);
    const prev = this.liquidPrev;
    const dt = prev && prev.positions.length === l.positions.length ? frame.t - prev.t : 0;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const p = l.positions;
    for (let i = 0; i < n; i++) {
      m.makeTranslation(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
      mesh.setMatrixAt(i, m);
      const v = dt > 0 ? Math.hypot(p[3 * i] - prev!.positions[3 * i], p[3 * i + 1] - prev!.positions[3 * i + 1], p[3 * i + 2] - prev!.positions[3 * i + 2]) / dt : 0;
      mesh.setColorAt(i, c.copy(STILL).lerp(FAST, Math.min(1, v / FAST_M_S)));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.liquidPrev = { positions: p, t: frame.t };
  }

  private buildGeom(g: GeomMeta, meshById: Map<number, SimMeta["meshes"][number]>): THREE.Object3D | null {
    const [r, gg, b, a] = g.rgba;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, gg, b),
      transparent: a < 1,
      opacity: a,
      roughness: 0.6,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const [sx, sy, sz] = g.size;
    switch (g.type) {
      case GEOM_PLANE: {
        const half = sx > 0 ? sx : 1.5;
        const halfY = sy > 0 ? sy : half;
        const geo = new THREE.PlaneGeometry(2 * half, 2 * halfY, 1, 1);
        const mesh = new THREE.Mesh(geo, material);
        const grid = new THREE.GridHelper(2 * half, 20, 0xb8b0a0, 0xd8d2c4);
        grid.applyMatrix4(ROT_Z_TO_Y);
        grid.position.z = 0.001;
        const group = new THREE.Group();
        group.add(mesh, grid);
        return group;
      }
      case GEOM_SPHERE:
        return new THREE.Mesh(new THREE.SphereGeometry(sx, 24, 16), material);
      case GEOM_ELLIPSOID: {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material);
        mesh.scale.set(sx, sy, sz);
        return mesh;
      }
      case GEOM_CAPSULE: {
        const geo = new THREE.CapsuleGeometry(sx, 2 * sy, 8, 16);
        geo.applyMatrix4(ROT_Z_TO_Y);
        return new THREE.Mesh(geo, material);
      }
      case GEOM_CYLINDER: {
        const geo = new THREE.CylinderGeometry(sx, sx, 2 * sy, 32);
        geo.applyMatrix4(ROT_Z_TO_Y);
        return new THREE.Mesh(geo, material);
      }
      case GEOM_BOX:
        return new THREE.Mesh(new THREE.BoxGeometry(2 * sx, 2 * sy, 2 * sz), material);
      case GEOM_MESH: {
        const m = meshById.get(g.meshId);
        if (!m) return null;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(m.faces), 1));
        geo.computeVertexNormals();
        return new THREE.Mesh(geo, material);
      }
      default:
        return null;
    }
  }

  update(frame: Frame) {
    const m = new THREE.Matrix4();
    for (const [id, obj] of this.objects) {
      const p = 3 * id;
      const r = 9 * id;
      const x = frame.geomXmat;
      m.set(
        x[r], x[r + 1], x[r + 2], frame.geomXpos[p],
        x[r + 3], x[r + 4], x[r + 5], frame.geomXpos[p + 1],
        x[r + 6], x[r + 7], x[r + 8], frame.geomXpos[p + 2],
        0, 0, 0, 1,
      );
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(m);
      // ellipsoids carry their radii as a scale on a unit sphere
      if (obj.scale.x !== 1 || obj.scale.y !== 1 || obj.scale.z !== 1) obj.matrix.scale(obj.scale);
    }
    this.updateLiquid(frame);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    disposeObject(this.marker);
    for (const d of this.built.values()) d.dispose();
    this.built.clear();
    this.setLiquid(null);
    for (const o of this.objects.values()) {
      this.scene.remove(o);
      disposeObject(o);
    }
    this.objects.clear();
    this.renderer.dispose();
  }
}

/** Free GPU buffers of a geom's object tree (meshes, grid lines); three.js never does it for us. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const g = (o as { geometry?: { dispose(): void } }).geometry;
    g?.dispose();
    const mat = (o as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
