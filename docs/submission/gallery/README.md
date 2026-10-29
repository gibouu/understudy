# Devpost image gallery

1800 x 1200 (3:2) images for the Devpost project gallery, in upload order. Every number on them comes from the repository; the source is named on each image.

| File | Devpost caption | What it shows | Source of its content |
|---|---|---|---|
| `01-architecture.png` | System architecture | Browser, Vercel routes, Nebius Token Factory models, Tavily, and what goes between them | `README.md` (Architecture, Which model does what), `app/api/` |
| `02-loop.png` | Rehearse, patch, pass | Watch, label, ask, then the rehearse and patch loop until it passes | `docs/MEASUREMENTS.md` section 8 (86%, 69%, 94%, $0.0024 per fix); the seed film run in `public/showcase/iss-veggie-seed-film.json` |
| `03-finetune.png` | Fine-tuning runs | The repair dataset, the five LoRA jobs and their validation loss per epoch | checkpoints in `bench/results/finetune-tf*.json`; `docs/FINETUNE.md`; `docs/submission/finetune-answer.md` |
| `04-rehearsal.gif` | Earth, then orbit | The arm rehearsing the seed film program, Earth then orbit (900 x 600, sped up 2x) | the live site, `/space/iss-veggie-seed-film`, station module |
| `05`–`10-site-*.png` | Home page · Space showcase · One-minute demo · What it saw · What it asked · How it improved | The live site: home, space showcase, one-minute demo, what the model saw, what the robot asked, how it improved | screenshots of https://understudy-rose.vercel.app on 27 October |
| `11-built.png` | How it was built | Pull requests, issues, test files, lines of code, commits per day, the call every model request goes through | GitHub and `git log` on 27 October; `lib/providers/call.ts` |

The diagrams are HTML in `src/` (open at 1800 x 1200 and screenshot with headless Chrome).
