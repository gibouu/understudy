/**
 * Where a clip came from, for the export (issue #61): each sample's source and
 * licence, copied verbatim from samples/README.md (tests/export/source.test.ts
 * holds them to it), and `"upload"` for a clip of your own. The quality report
 * says it, and `understudy/recording.json` carries it as `source` next to the
 * clip's metadata.
 */
import type { Sample } from "@/lib/samples";

export type SampleSource = {
  library: string;
  title: string;
  url: string;
  /** the NASA Image and Video Library id, when the clip comes from it */
  nasa_id?: string;
  credit: string;
  /** which part of the source the clip is */
  excerpt: string;
  licence: string;
};

export type ClipSource = SampleSource | "upload";

const NASA = "NASA Image and Video Library";
const PUBLIC_DOMAIN = "Public domain (work of NASA)";
const VEG_03J = {
  library: NASA,
  title: "NASA astronaut Mike Hopkins planting Veg-03J aboard ISS",
  url: "https://images.nasa.gov/details/KSC-20250806-MH-NAS01-0001-Veg_03J_Aboard_ISS_iss064m120041018-M15939",
  nasa_id: "KSC-20250806-MH-NAS01-0001-Veg_03J_Aboard_ISS_iss064m120041018-M15939",
  credit: "NASA",
  licence: PUBLIC_DOMAIN,
};

export const SAMPLE_SOURCES: Record<Sample["name"], SampleSource> = {
  "iss-veggie-seed-film": { ...VEG_03J, excerpt: "medium rendition, seconds 178 to 214" },
  "iss-veggie-seed-film-2": { ...VEG_03J, excerpt: "medium rendition, seconds 100 to 136" },
  "iss-fluid-bag-foam": {
    library: NASA,
    title: "Fruit Punch and Foam: Managing Liquids in Space",
    url: "https://images.nasa.gov/details/jsc2020m000202_Fruit-Punch_and_Foam_Managing_Liquids_in_Space-MP4",
    nasa_id: "jsc2020m000202_Fruit-Punch_and_Foam_Managing_Liquids_in_Space-MP4",
    credit: "NASA",
    excerpt: "medium rendition, seconds 91.3 to 101.5",
    licence: PUBLIC_DOMAIN,
  },
  "iss-glovebox-pipette": {
    library: NASA,
    title: "NASA Astronauts Butch Wilmore and Suni Williams conduct International Space Station research",
    url: "https://images.nasa.gov/details/jsc2024m000183_Butch_Wilmore_and_Suni_Williams_conduct_International_Space_Station_Research_241112-MP4",
    nasa_id: "jsc2024m000183_Butch_Wilmore_and_Suni_Williams_conduct_International_Space_Station_Research_241112-MP4",
    credit: "NASA",
    excerpt: "medium rendition, seconds 227.3 to 238.1",
    licence: PUBLIC_DOMAIN,
  },
  "iss-wave": {
    library: NASA,
    title: "NASA Astronaut Nick Hague Talks with KFI-AM, Los Angeles - Wednesday, October 23, 2024",
    url: "https://images.nasa.gov/details/iss072m262971234_NASA_Astronaut_Nick_Hague_Talks_with_KFI-AM_Los_Angeles_241023",
    nasa_id: "iss072m262971234_NASA_Astronaut_Nick_Hague_Talks_with_KFI-AM_Los_Angeles_241023",
    credit: "NASA",
    excerpt: "medium rendition, seconds 1058.5 to 1064.5",
    licence: PUBLIC_DOMAIN,
  },
  "dev-clip": {
    library: "Wikimedia Commons",
    title: "Earth vs. Space Chess Match; Chamitoff Makes his Move",
    url: "https://commons.wikimedia.org/wiki/File:Earth_vs._Space_Chess_Match;_Chamitoff_Makes_his_Move.webm",
    credit: "NASA Johnson",
    excerpt: "seconds 4 to 34",
    licence: PUBLIC_DOMAIN,
  },
};

/** A sample's source, by the clip's name; any other clip is one of your own. */
export function clipSource(name: string): ClipSource {
  return Object.hasOwn(SAMPLE_SOURCES, name) ? SAMPLE_SOURCES[name as Sample["name"]] : "upload";
}

/** The quality report's section on the clip. */
export function sourceMarkdown(source: ClipSource): string[] {
  if (source === "upload") return ["## Source", "", 'An uploaded clip (`source: "upload"`): where it comes from and its licence are for whoever uploaded it to say.', ""];
  const id = source.nasa_id ? `, nasa_id \`${source.nasa_id}\`` : "";
  return [
    "## Source",
    "",
    `${source.library}, "${source.title}" (${source.url}${id}), ${source.excerpt}.`,
    "",
    `Credit: ${source.credit}. Licence: ${source.licence}.`,
    "",
  ];
}
