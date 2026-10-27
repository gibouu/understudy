/**
 * The SO-101 follower arm from MuJoCo Menagerie (robotstudio_so101, Apache-2.0,
 * licence file next to the model under assets/so101). scripts/copy-assets.mjs
 * publishes the MJCF, a gzipped mesh bundle and the raw meshes (fallback) under
 * /so101; the worker writes them into the engine's file system (mountSo101).
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { toNumbers } from "./names";
export const SO101_ASSET_BASE = "/so101";
export const SO101_XML = "so101.xml";
/** 4-byte little-endian header length, a JSON index [{name, offset, length}], then the bytes; gzipped. */
export const SO101_MESH_BUNDLE = "meshes.bin.gz";
/** Where mountSo101 puts the MJCF (its meshes under assets/, the MJCF's meshdir) in the engine's own file system. */
export const SO101_DIR = "/so101";
/** The meshes the MJCF references, for the per-file fallback. */
export const SO101_MESHES = [
  "base_motor_holder_so101_v1.stl",
  "base_so101_v2.stl",
  "motor_holder_so101_base_v1.stl",
  "motor_holder_so101_wrist_v1.stl",
  "moving_jaw_so101_gripper_part0_v1.stl",
  "moving_jaw_so101_gripper_part1_v1.stl",
  "moving_jaw_so101_gripper_v1.stl",
  "moving_jaw_so101_v1.stl",
  "rotation_pitch_so101_v1.stl",
  "sts3215_03a_no_horn_v1.stl",
  "sts3215_03a_v1.stl",
  "under_arm_so101_v1.stl",
  "upper_arm_so101_v1.stl",
  "waveshare_mounting_plate_so101_v2.stl",
  "wrist_roll_follower_so101_camera_mount.stl",
  "wrist_roll_follower_so101_gripper_part0_v1.stl",
  "wrist_roll_follower_so101_v1.stl",
  "wrist_roll_pitch_so101_v2.stl",
] as const;

/**
 * Write the MJCF and its meshes into Emscripten's in-memory file system and make that directory the working one,
 * where stageXml's include and the MJCF's meshdir find them: compile with `MjModel.from_xml_string(stageXml(...))`.
 * The same bytes through MjVFS.addBuffer cross Embind one element at a time, about 4 s for the 17 MB of meshes on
 * every load; a file write is one copy. Writing again replaces the files.
 */
export function mountSo101(mujoco: MainModule, xml: Uint8Array, meshes: { name: string; bytes: Uint8Array }[]) {
  const { FS } = mujoco;
  FS.mkdirTree(`${SO101_DIR}/assets`, 0o777);
  FS.writeFile(`${SO101_DIR}/${SO101_XML}`, xml);
  for (const m of meshes) FS.writeFile(`${SO101_DIR}/assets/${m.name}`, m.bytes);
  FS.chdir(SO101_DIR);
}

/** Joint order, equal to the actuator order and to GR00T's so101_follower state layout. */
export const SO101_JOINT_NAMES = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
] as const;

/** The site at the gripper tip used for IK and for measuring reach. */
export const SO101_TIP_SITE = "gripperframe";

/** The site between the jaw pads: IK aims it at an object's grasp point. */
export const SO101_GRASP_SITE = "graspframe";
/** A site on the gripper that a grasp moves onto the held object's centre: IK on it places the object, wherever the jaws caught it. */
export const SO101_HELD_SITE = "heldframe";

/** The body carrying the fixed jaw; a grasp welds the object to it. */
export const SO101_GRIPPER_BODY = "gripper";
/** The moving jaw's body, a child of the gripper. */
export const SO101_MOVING_JAW_BODY = "moving_jaw_so101_v1";

/** Gripper actuator targets, radians: fully closed (squeezes whatever is between the pads) and open (about 60 mm between the pads). */
export const GRIPPER_CLOSED = -0.17453;
export const GRIPPER_OPEN = 0.6;

/** The equality that welds `body` to the gripper; declared off, switched on by a grasp. */
export const graspWeld = (body: string) => `grasp_${body}`;

/** A resting pose that keeps the arm off the floor. Radians, joint order above. */
export const SO101_HOME: number[] = [0, -1.3, 1.2, 0.6, 0, 0.3];

export const G_M_S2 = 9.81;

/**
 * Put the arm at home, holding it there: a freshly built or reset model has it at qpos0 (all joints zero), and
 * the move home from there sweeps through the space in front of the robot, knocking over what stands there.
 */
export function park(mujoco: MainModule, model: MjModel, data: MjData) {
  const adr = toNumbers(model.jnt_qposadr);
  const qpos = data.qpos as Float64Array;
  SO101_JOINT_NAMES.forEach((name, i) => {
    const j = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name);
    if (j >= 0) qpos[adr[j]] = SO101_HOME[i];
  });
  (data.ctrl as Float64Array).set(SO101_HOME.slice(0, SO101_JOINT_NAMES.length));
  mujoco.mj_forward(model, data);
}

/**
 * The stage: floor, light and the arm. The arm's own <option> sets the
 * timestep (0.005 s, tuned by Menagerie for its actuators); gravity is set
 * here, after the include, so it wins: 1 g on Earth, 0.1654 g on the Moon,
 * 0 g in orbit. Task objects are appended by the scene builder; each body in
 * `graspable` gets a weld to the gripper, declared inactive.
 */
export function stageXml(extraWorldbody = "", options: { gravity_g?: number; graspable?: string[] } = {}): string {
  const g = options.gravity_g ?? 1;
  const welds = (options.graspable ?? []).map(
    (b) => `<weld name="${graspWeld(b)}" body1="${SO101_GRIPPER_BODY}" body2="${b}" active="false" solref="0.01 1"/>`,
  );
  return `<mujoco model="understudy-stage">
  <include file="${SO101_XML}"/>
  <option gravity="0 0 ${-(G_M_S2 * g)}"/>
  <visual>
    <headlight diffuse="0.6 0.6 0.6" ambient="0.3 0.3 0.3" specular="0 0 0"/>
    <global azimuth="160" elevation="-20"/>
  </visual>
  <asset>
    <texture type="2d" name="groundplane" builtin="checker" mark="edge" rgb1="0.92 0.90 0.84" rgb2="0.86 0.84 0.78" markrgb="0.7 0.7 0.7" width="300" height="300"/>
    <material name="groundplane" texture="groundplane" texuniform="true" texrepeat="5 5" reflectance="0.1"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" size="0 0 0.05" pos="0 0 0" type="plane" material="groundplane" rgba="0.9 0.88 0.82 1"/>
    ${extraWorldbody}
  </worldbody>
  ${welds.length ? `<equality>${welds.join("")}</equality>` : ""}
</mujoco>`;
}
