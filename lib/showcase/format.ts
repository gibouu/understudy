/** Words and money for the showcase pages; nothing here reads files, so the story can use it. */
import type { Session } from "./session";

/** Where the last iteration stands, in words: "passes on Earth, fails in orbit". */
export function verdict(session: Session): string {
  const { earth, orbit } = session.iterations.at(-1)!.results;
  if (earth.pass && orbit.pass) return "passes on Earth and in orbit";
  if (!earth.pass && !orbit.pass) return "fails on Earth and in orbit";
  return earth.pass ? "passes on Earth, fails in orbit" : "fails on Earth, passes in orbit";
}

/** Small sums keep four decimals: a whole recording costs a fraction of a cent. */
export const usd = (x: number) => (x < 0.01 ? `US$${x.toFixed(4)}` : `US$${x.toFixed(2)}`);
