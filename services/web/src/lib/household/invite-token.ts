import { createHash, randomBytes } from "node:crypto";

/**
 * Invite token generation + hashing (§6.1).
 *
 * The RAW token is high-entropy (32 random bytes) and appears ONLY in the
 * shareable `/invite/<token>` link we hand back to the creating owner. We store
 * `token_hash = sha256(token)` (hex) and NEVER the raw token — a leaked DB dump
 * can't be replayed into an accepted invite. Because the token is already
 * high-entropy, a fast cryptographic hash is sufficient; a slow KDF buys nothing
 * here.
 *
 * PURE — no DB, no framework. Unit-tested (hash is stable and never equals the
 * token).
 */

/** A fresh URL-safe invite token: 32 random bytes, base64url (~43 chars). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the token, hex-encoded — the value we persist and look up by. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
