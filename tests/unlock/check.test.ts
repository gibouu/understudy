import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/label/route";
import { SAMPLES } from "@/lib/samples";
import { checkUnlock, UNLOCK_ENV } from "@/lib/unlock/check";
import { isUnlockRefusal, UNLOCK_NEEDED, UNLOCK_WRONG } from "@/lib/unlock/messages";

const sampleSha = createHash("sha256")
  .update(readFileSync(path.join(process.cwd(), "samples", `${SAMPLES[0].name}.mp4`)))
  .digest("hex");
const ownSha = "a".repeat(64);

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the unlock code for clips of your own", () => {
  it("lets every clip through when the variable is not set, and logs it", async () => {
    vi.stubEnv(UNLOCK_ENV, "");
    expect(await checkUnlock(ownSha, undefined)).toBeNull();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(`${UNLOCK_ENV} is not set`));
  });

  it("lets a sample through without a code", async () => {
    vi.stubEnv(UNLOCK_ENV, "orbit");
    expect(await checkUnlock(sampleSha, undefined)).toBeNull();
  });

  it("asks for the code for any other clip, and refuses a wrong one", async () => {
    vi.stubEnv(UNLOCK_ENV, "orbit");
    expect(await checkUnlock(ownSha, undefined)).toEqual({ status: 401, message: UNLOCK_NEEDED });
    expect(await checkUnlock(undefined, "  ")).toEqual({ status: 401, message: UNLOCK_NEEDED });
    expect(await checkUnlock(ownSha, "orbiT")).toEqual({ status: 403, message: UNLOCK_WRONG });
    expect(await checkUnlock(ownSha, "a much longer guess than the code")).toEqual({ status: 403, message: UNLOCK_WRONG });
    expect(await checkUnlock(ownSha, " orbit ")).toBeNull();
    expect([UNLOCK_NEEDED, UNLOCK_WRONG].every(isUnlockRefusal)).toBe(true);
  });
});

describe("POST /api/label with a key and the code set", () => {
  const post = (body: unknown, query = "") => POST(new Request(`http://x/api/label${query}`, { method: "POST", body: JSON.stringify(body) }));

  beforeEach(() => {
    vi.stubEnv("NEBIUS_API_KEY", "test-key-never-sent");
    vi.stubEnv(UNLOCK_ENV, "orbit");
  });

  it("refuses a clip of your own before anything is sent to the model", async () => {
    const res = await post({ clip_sha256: ownSha, video: "data:video/mp4;base64,AAAA", duration_s: 8 });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ status: "failed", message: UNLOCK_NEEDED, retryable: false });
    const wrong = await post({ clip_sha256: ownSha, video: "data:video/mp4;base64,AAAA", duration_s: 8, unlock: "nope" });
    expect(wrong.status).toBe(403);
  });

  it("passes the right code and a sample on to the usual checks", async () => {
    // an invalid video stops at the 400 that follows the unlock check, so no model call is made
    for (const body of [
      { clip_sha256: ownSha, unlock: "orbit", video: "not a data uri" },
      { clip_sha256: sampleSha, video: "not a data uri" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
  });

  it("never asks for the code in replay, which costs nothing", async () => {
    const res = await post({ clip_sha256: ownSha }, "?replay=1");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("done");
  });
});
