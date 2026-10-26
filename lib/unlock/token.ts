/**
 * The sample token: /api/label hands one out when it labels a sample clip
 * live, and the page sends it back with every later model call of that
 * session, so /api/compile, /api/notes, /api/variants and /api/ground know the
 * session started from a sample without trusting the spec they are posted
 * (its title or provenance can say anything). It is `<expiry>.<HMAC-SHA256 of
 * the expiry>` under UNDERSTUDY_TOKEN_SECRET: nothing is stored, any instance
 * can check it, and it lapses after an hour.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_ENV = "UNDERSTUDY_TOKEN_SECRET";
export const SAMPLE_TOKEN_TTL_S = 3600;
/** shorter secrets would let a token be brute-forced offline */
const MIN_SECRET_CHARS = 32;

export type TokenState = "valid" | "expired" | "invalid" | "none";

/** The signing secret, or undefined (logged) when it is missing or too short to trust. */
export function tokenSecret(): string | undefined {
  const secret = process.env[TOKEN_ENV]?.trim();
  if (!secret) return undefined;
  if (secret.length < MIN_SECRET_CHARS) {
    console.warn(`unlock: ${TOKEN_ENV} is shorter than ${MIN_SECRET_CHARS} characters, so it is not used`);
    return undefined;
  }
  return secret;
}

const mac = (secret: string, exp: number) => createHmac("sha256", secret).update(`understudy sample session until ${exp}`).digest("base64url");

/** A token for a session that starts from a sample clip now; undefined without a secret. */
export function sampleToken(now = Date.now()): string | undefined {
  const secret = tokenSecret();
  if (!secret) return undefined;
  const exp = Math.floor(now / 1000) + SAMPLE_TOKEN_TTL_S;
  return `${exp}.${mac(secret, exp)}`;
}

export function readSampleToken(token: unknown, now = Date.now()): TokenState {
  if (typeof token !== "string" || token === "") return "none";
  const secret = tokenSecret();
  const parts = /^(\d{1,12})\.([\w-]{43})$/.exec(token);
  if (!secret || !parts) return "invalid";
  const exp = Number(parts[1]);
  // both are 43 base64url characters, so the comparison takes the same time whatever was sent
  if (!timingSafeEqual(Buffer.from(parts[2]), Buffer.from(mac(secret, exp)))) return "invalid";
  return exp > now / 1000 ? "valid" : "expired";
}
