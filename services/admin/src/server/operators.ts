import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "./session";

/**
 * Who can get into this tool.
 *
 * Read-only on purpose, for now. Minting and revoking operators happens with
 * shell access (`pnpm --filter @buttery/admin admin:create`, or an UPDATE on
 * `admin.admin_user.disabled_at`) — the first write surface an internal tool
 * should grow is not the one that hands out access to itself. This page exists
 * so an operator can *see* the roster and each account's live session count,
 * which is the question that actually comes up.
 */

export interface OperatorRow {
  id: string;
  name: string;
  email: string;
  role: string;
  disabled_at: string | null;
  createdAt: string;
  activeSessions: number;
  lastSessionAt: string | null;
}

export const listOperators = createServerFn({ method: "GET" }).handler(async (): Promise<OperatorRow[]> => {
  await requireAdmin();
  const { getDb } = await import("#/lib/db");
  const db = getDb();

  const rows = await db
    .selectFrom("admin.admin_user as u")
    .select((eb) => [
      "u.id",
      "u.name",
      "u.email",
      "u.role",
      "u.disabled_at",
      "u.createdAt",
      eb
        .selectFrom("admin.admin_session as s")
        .whereRef("s.userId", "=", "u.id")
        .where("s.expiresAt", ">", new Date())
        .select((inner) => inner.fn.countAll<string>().as("count"))
        .as("active_sessions"),
      eb
        .selectFrom("admin.admin_session as s")
        .whereRef("s.userId", "=", "u.id")
        .select((inner) => inner.fn.max("s.createdAt").as("at"))
        .as("last_session_at"),
    ])
    .orderBy("u.createdAt", "asc")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    disabled_at: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    activeSessions: Number(row.active_sessions ?? 0),
    lastSessionAt: row.last_session_at ? new Date(row.last_session_at).toISOString() : null,
  }));
});
