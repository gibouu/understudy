# Re-recorded showcase clips (#152)

gib, 27 Oct: "Re-record the pipette and second seed-film clips until a run passes (up to 5 tries each), and say on the page which run was kept, out of how many."

Every run of each clip is here, in recording order, so the count on `/space` can be checked:

- `run-1.json` is the recording that was on main (made on 27 Oct, #140); the later runs were made the same day with `lib/showcase/record.ts` on the original Nemotron 3 Nano and Nemotron 3 Super (`UNDERSTUDY_KEEP_RETIRED=1`), with the same recorded answers.
- The loop stopped at the first run whose last program passes on Earth and in orbit, with at most 5 new runs per clip; `attempt-<n>.log` is the recorder's output for each new run (no attempt stopped on a bad model answer).
- The kept run is `public/showcase/<clip>.json`: the same file plus its `selection` (the run kept, out of how many), written by hand afterwards. `lib/showcase/record.test.ts` checks that it matches its run here and that the count is right.

| Clip | Runs | Kept | Before it |
|---|---|---|---|
| `iss-glovebox-pipette` | 4 | run 4: passes after one Notes patch | runs 1 to 3 still failed after five patches (run 1 on Earth and in orbit, runs 2 and 3 in orbit) |
| `iss-veggie-seed-film-2` | 2 | run 2: passes after the interview, no patch needed | run 1 still failed on Earth and in orbit after five patches |

Spend for the new runs: US$0.027.
