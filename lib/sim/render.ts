/**
 * three.js view of the MuJoCo scene. Geometry comes from the model itself
 * (mesh vertices and faces, primitive sizes), poses from each frame.
 * MuJoCo is Z-up; the camera is told so and everything else follows.
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

const ROT_Z_TO_Y = new THREE.Matrix4().makeRotationX(Math.PI / 2);

export class StageRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private objects = new Map<number, THREE.Object3D>();
  private raf = 0;
  private resizeObserver: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0xf4f1ea);
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

  setMeta(meta: SimMeta) {
    for (const o of this.objects.values()) {
      this.scene.remove(o);
      disposeObject(o);
    }
    this.objects.clear();
    const meshById = new Map(meta.meshes.map((m) => [m.id, m]));
    for (const g of meta.geoms) {
      if (g.group >= 3) continue; // collision-only geoms
      const obj = this.buildGeom(g, meshById);
      if (!obj) continue;
      this.scene.add(obj);
      this.objects.set(g.id, obj);
    }
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
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
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
