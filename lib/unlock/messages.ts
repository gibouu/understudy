/**
 * What /api/label answers when a clip of your own needs the unlock code, and
 * where the page keeps the code once typed. Shared by the route
 * (lib/unlock/check.ts) and the page (app/capture.tsx); nothing secret here.
 */
export const UNLOCK_NEEDED = "Clips of your own need the unlock code; the sample clips run without it.";
export const UNLOCK_WRONG = "That unlock code is not right.";
export const UNLOCK_STORAGE_KEY = "understudy.unlock";

export const isUnlockRefusal = (message: string) => message === UNLOCK_NEEDED || message === UNLOCK_WRONG;
