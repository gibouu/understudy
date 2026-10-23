/**
 * The SO-101 follower arm from MuJoCo Menagerie (robotstudio_so101, Apache-2.0,
 * licence file next to the model under assets/so101). scripts/copy-assets.mjs
 * publishes the MJCF, a gzipped mesh bundle and the raw meshes (fallback) under
 * /so101; the worker puts them into MuJoCo's virtual file system.
 */
export const SO101_ASSET_BASE = "/so101";
export const SO101_XML = "so101.xml";
/** 4-byte little-endian header length, a JSON index [{name, offset, length}], then the bytes; gzipped. */
export const SO101_MESH_BUNDLE = "meshes.bin.gz";
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

/** A resting pose that keeps the arm off the floor. Radians, joint order above. */
export const SO101_HOME: number[] = [0, -1.3, 1.2, 0.6, 0, 0.3];

/**
 * The stage: floor, light and the arm. The arm's own <option> (timestep
 * 0.005 s, tuned by Menagerie for its actuators) wins over anything set here;
 * the worker reads the compiled timestep. Task objects are appended by the
 * scene builder (issue #18); this spike only needs the arm.
 */
export function stageXml(extraWorldbody = ""): string {
  return `<mujoco model="understudy-stage">
  <include file="${SO101_XML}"/>
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
</mujoco>`;
}
