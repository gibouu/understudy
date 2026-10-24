# Demo video script (three minutes or less)

Recorded on the live path with the cost ledger visible. Plain-text captions naming each model ID as it is used. No logos, no music, no third-party trademarks. Five moments a judge should lean in for: the tokens blooming over the human, a question changing the spec live, the robot rehearsing on the stage, the scoreboard climbing from the standard approach through the interview and the patch, and the second clip starting higher because of the playbook.

Recorded on the live path with the ledger strip visible; plain-text captions, no logos, no music.

- **0:00-0:15** An astronaut on the ISS slipping seed film into a plant pillow (NASA public-domain footage, `samples/iss-veggie-seed-film.mp4`), then a hand moving a tube into a rack on a bench. VO: "Every crew hour up there is scarce. Down here, a fifth of the footage collected for robots is thrown away. Nobody asks the person who did the task."
- **0:15-0:35** Clip in the browser; skeleton, chips, anchor marker. VO: "MediaPipe turns motion into tokens."
- **0:35-0:55** Labels land on chips; caption `nvidia/Nemotron-3.5-Super-VL` on Nebius Token Factory; ledger visible.
- **0:55-1:30** Nano's program with red `ask` slots; question one cites "aperture 61 mm at t=1.3 s"; a chip click flashes the changed path; an opt-in Tavily card. VO: "Nano plays the robot. What it cannot execute, Super asks the person who did it."
- **1:30-1:50** SO-101 runs the program with the via-point ghost line. VO: "Rehearsed on a real robot model in MuJoCo, in the browser."
- **1:50-2:15** The scoreboard: iteration 0 (retarget and replay, no interview) scores a handful of the 24 rollouts; iteration 1 (after the interview) climbs; a scenario is edited and re-run, the tube hits the pocket wall; Super proposes "raise the pre-insert via-point", Nano recompiles, iteration 2 climbs again. VO: "Same clip, same 24 rollouts. The standard approach, the interviewed spec, the patched program. Blind, a few millimetres. With a pose estimate, the whole tray. That is the perception budget."
- **2:15-2:25** The second clip starts: its iteration 0 is already higher, and the playbook panel shows the rule learned on the first clip with its evidence. VO: "What fixed the first task is now a rule the next one starts from."
- **2:25-2:40** Orbit mode: the gravity switch goes to 0 g, the same program runs, the released tube drifts out of the rack, the scenario fails; the patch holds the tube until it is inside the pocket, and it passes. VO: "Same program, zero gravity. On Earth the tube rests. In orbit it drifts. The rehearsal catches it before a robot does it for real." One sentence over the scoreboard: "The same loop serves satellite servicing, where the stakes are a spacecraft."
- **2:40-2:50** Ultra's reshoot list; the zip; Job log if produced. Caption `nvidia/Nemotron-3-Ultra-550b-a55b`.
- **2:50-3:00** Limits card (rigid-body physics, a gravity switch, not a flight test); model credits.

## Physical AI requirement

At least one minute of the video shows the key application modules in action (the rehearsal stage, the 2x12 grid, the fail, patch, pass loop). The app has no hardware component; the README says so.
