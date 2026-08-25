import { createAuthClient } from "better-auth/react";

/**
 * The admin's better-auth browser client. Deliberately plugin-free: the app's
 * client carries the atproto OAuth plugin, and the admin has no business
 * speaking that protocol — an operator signs in with an email and a password
 * against `admin.admin_user`, full stop.
 *
 * It talks to this service's own `/api/auth/*` on the same origin, so nothing
 * here needs a baseURL.
 */
export const authClient = createAuthClient();

export type AdminUser = typeof authClient.$Infer.Session.user;
