# Sample clips

| File | What it shows | Source | Licence |
|---|---|---|---|
| `dev-clip.mp4` | Stand-in until gib's three clips are filmed (issue #5): one person facing the camera moving chess pieces on a board held in front of him. Not a tabletop task in the strict sense; it exercises pose, hand matching and hand loss. 30 s, 1280x720, 30 fps, H.264, no audio, 2.1 MB. | NASA Johnson, "Earth vs. Space Chess Match; Chamitoff Makes his Move" (2008), [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Earth_vs._Space_Chess_Match;_Chamitoff_Makes_his_Move.webm), seconds 4 to 34, re-encoded with `ffmpeg -ss 4 -t 30 -an -vf scale=1280:-2,fps=30 -c:v libx264 -crf 26` | Public domain (work of NASA) |

The clips are served at `/samples/<name>.mp4` by `app/samples/[name]/route.ts`.
