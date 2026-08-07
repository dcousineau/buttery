import { authClient } from "./auth-client";

/**
 * Send the signed-in user back through atproto authorization to pick up the
 * current scope set.
 *
 * An OAuth grant is frozen at the scopes it was issued with — a refresh token
 * renews the same grant, it never widens it. So when `ATPROTO_SCOPE` gains a
 * permission (as it did when publishing started uploading image blobs and
 * writing recipe records), every session issued before that keeps failing with
 * a 403 until its owner re-authorizes. This re-runs the same flow the login
 * screen uses; the callback replaces the stored session with a correctly-scoped
 * one and the user lands back on `/`.
 *
 * Returns an error string on failure, or never returns (the browser navigates
 * away) on success.
 */
export async function reconnectAtproto(handle: string | null | undefined): Promise<string> {
  if (!handle) return "Missing account handle — sign out and sign back in.";
  const { data, error } = await authClient.atproto.signIn({ handle });
  if (error || !data?.url) return error?.message ?? "Could not start re-authorization.";
  window.location.href = data.url;
  // The navigation above ends this task; the return keeps callers total.
  return "";
}
