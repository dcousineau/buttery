import { createServerFn } from "@tanstack/react-start";

/**
 * Soft-launch gate. While `COMING_SOON=true`, the app serves only the
 * coming-soon page and the login + recipe server APIs refuse requests. Set on
 * the Railway production service; leave unset in local dev so the real app
 * shows. Read lazily inside a function so this module stays browser-safe (the
 * `getComingSoon` server fn is imported into the client bundle, but the
 * `process.env` access never runs there).
 */
export function isComingSoon(): boolean {
  return process.env.COMING_SOON === "true";
}

/** Surface the soft-launch flag to the SSR / browser render. */
export const getComingSoon = createServerFn({ method: "GET" }).handler(() => isComingSoon());
