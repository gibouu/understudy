# Sample clips

| File | What it shows | Source | Licence |
|---|---|---|---|
| `iss-veggie-seed-film.mp4` | The hero clip. NASA astronaut Mike Hopkins at the Veggie facility aboard the International Space Station, placing seed film into the plant pillows (Veg-03J, 2021): one fixed camera, one take, gloved hands visible, a small film strip going into a pocket, in microgravity. 36 s, 1280x720, 30 fps, H.264, no audio, 3.8 MB. | NASA Image and Video Library, [NASA astronaut Mike Hopkins planting Veg-03J aboard ISS](https://images.nasa.gov/details/KSC-20250806-MH-NAS01-0001-Veg_03J_Aboard_ISS_iss064m120041018-M15939) (nasa_id `KSC-20250806-MH-NAS01-0001-Veg_03J_Aboard_ISS_iss064m120041018-M15939`, credit NASA), medium rendition, seconds 178 to 214, re-encoded with `ffmpeg -ss 178 -t 36 -an -vf scale=1280:-2 -c:v libx264 -preset slow -crf 25 -movflags +faststart` | Public domain (work of NASA) |
| `dev-clip.mp4` | Development clip: one person facing the camera with a chess board held in front of him, aboard the ISS; no piece is moved in this 30 s window (checked frame by frame on 25 October 2026). Not a tabletop task in the strict sense; it exercises pose, hand matching and hand loss. 30 s, 1280x720, 30 fps, H.264, no audio, 2.1 MB. | NASA Johnson, "Earth vs. Space Chess Match; Chamitoff Makes his Move" (2008), [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Earth_vs._Space_Chess_Match;_Chamitoff_Makes_his_Move.webm), seconds 4 to 34, re-encoded with `ffmpeg -ss 4 -t 30 -an -vf scale=1280:-2,fps=30 -c:v libx264 -crf 26` | Public domain (work of NASA) |

The two household clips (a capped marker into a cardboard rack, a cup onto a saucer) land with issue #5.

## Using NASA footage

NASA's media are not copyrighted and may be used for informational and educational purposes, which is what this repository does. Three rules follow from [NASA's media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) and are kept here:

- The NASA insignia, logotype and seal never appear in anything Understudy generates (thumbnails, renders, exports). The clip is shown as footage, nothing more.
- An astronaut's likeness is not used to endorse anything. The clip is a demonstration input; nothing here implies that NASA or the crew endorse Understudy.
- The source and credit stay attached: this table is the record, and the export writer will carry them in a `source` field (issue #61).

The clips are served at `/samples/<name>.mp4` by `app/samples/[name]/route.ts`.
