import { randomBytes } from "node:crypto";

/**
 * ULID minting for our own private rows (`household.id`, `household_invite.id`).
 *
 * Recipe ids in this repo are ULIDs too, but those arrive from the atproto
 * network as record rkeys — the repo has no ULID *generator* dependency, and we
 * can't add one here (installs are frozen in this worktree). So we mint locally
 * with Node `crypto`, producing the exact same 26-char Crockford-base32 shape
 * the `recipe` layer already validates against
 * (`/^[0-9A-HJKMNP-TV-Z]{26}$/i`, see `lib/atproto/recipe-exchange.ts`):
 * a 48-bit millisecond timestamp (10 chars) + 80 bits of randomness (16 chars).
 * Time-prefixing keeps ids roughly sortable by creation, like a real ULID.
 *
 * PURE / server-agnostic — safe to unit-test without a database.
 */

/** Crockford base32 alphabet (no I, L, O, U). Matches the ULID spec. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  // 256 is an exact multiple of 32, so `byte % 32` is perfectly uniform — no
  // modulo bias to correct for.
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i] % 32];
  }
  return out;
}

/** A fresh, time-prefixed ULID string (26 Crockford-base32 chars). */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN);
}
