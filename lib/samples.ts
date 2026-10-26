/**
 * Clips under samples/ (sources and licences in samples/README.md), each with
 * the line its uploader would type. One registry for the guided flow and the
 * showcase; served at /samples/<name>.mp4 by app/samples/[name]/route.ts.
 */
export const SAMPLES = [
  { name: "iss-veggie-seed-film", label: "ISS: seed film into a plant pillow (NASA, 36 s)", hint: "aboard the ISS, planting seed film into the Veggie plant pillows" },
  { name: "iss-fluid-bag-foam", label: "ISS: drink bag squeezed into foam (NASA, 17.5 s)", hint: "aboard the ISS, squeezing a drink bag of fruit punch through tubing into a foam block" },
  { name: "iss-glovebox-pipette", label: "ISS: pipette into a sample cartridge (NASA, 18 s)", hint: "aboard the ISS, in a glovebox, pipetting liquid into a sample cartridge" },
  { name: "iss-veggie-seed-film-2", label: "ISS: seed film into plant pillows, later pass (NASA, 36 s)", hint: "aboard the ISS, planting seed film into the Veggie plant pillows" },
  { name: "dev-clip", label: "ISS: chess (NASA, 30 s)", hint: "aboard the ISS, chess match" },
] as const;

export type Sample = (typeof SAMPLES)[number];
