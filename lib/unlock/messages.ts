/**
 * What /api/label answers when a clip of your own needs the unlock code, and
 * where the page keeps the code once typed. Shared by the routes
 * (lib/unlock/check.ts) and the page (app/capture.tsx); nothing secret here.
 */
export const UNLOCK_NEEDED = "Clips of your own need the unlock code; the sample clips run without it.";
export const UNLOCK_WRONG = "That unlock code is not right.";
export const UNLOCK_STORAGE_KEY = "understudy.unlock";

export const isUnlockRefusal = (message: string) => message === UNLOCK_NEEDED || message === UNLOCK_WRONG;

/**
 * Why a route answered from its recording instead of going live (lib/unlock/check.ts).
 * Each starts with "replay", so the page marks the answer as replayed, and shows this line.
 */
export const LIVE_NEEDS_PASS = "replay: live model calls need the unlock code, or a session that starts from a sample clip";
export const LIVE_WRONG_CODE = "replay: the unlock code sent is not right";
export const LIVE_EXPIRED = "replay: this sample session is over an hour old; watch the clip again to go live";
export const LIVE_NO_SECRET = "replay: this deployment cannot vouch for sample sessions, so live calls after the label need the unlock code";
export const LIVE_CLOSED = "replay: live model calls outside a sample session are closed on this deployment until its unlock code is set";
export const LIVE_BUSY = "replay: this server has made all the live calls it allows for this minute; try again shortly";

const GATE_NOTES: readonly string[] = [LIVE_NEEDS_PASS, LIVE_WRONG_CODE, LIVE_EXPIRED, LIVE_NO_SECRET, LIVE_CLOSED, LIVE_BUSY];

/** The line that says why an answer was replayed, when the spend guard is the reason. */
export const gateNote = (warnings: string[]) => warnings.find((w) => GATE_NOTES.includes(w));
