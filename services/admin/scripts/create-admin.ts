/**
 * Mint an operator account for the backoffice admin.
 *
 * This is the ONLY way to create one: `emailAndPassword.disableSignUp` closes
 * the public `/sign-up/email` endpoint, so an account requires shell access to
 * the machine and the database. That is the intended bar for a tool whose every
 * page is other people's data.
 *
 * It goes through `auth.api.signUpEmail` rather than writing the rows itself,
 * so the password hash is produced by exactly the code that will later verify
 * it — a hand-rolled INSERT is how you end up with an account that exists and
 * can never sign in. `disableSignUp` turns registration off in the server-side
 * API too, not just the HTTP route, so this builds its own instance from
 * `createAdminAuth({ allowSignUp: true })`: same tables, same secret, same
 * hashing, registration open for exactly the length of this process.
 *
 * Usage:
 *   pnpm --filter @buttery/admin admin:create \
 *     --email dev@buttery.test --password 'correct horse battery staple' --name 'Dev Operator'
 *
 * Reads DATABASE_URL and ADMIN_BETTER_AUTH_SECRET from services/admin/.env.
 */
import { parseArgs } from "node:util";

process.loadEnvFile();

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    password: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "admin" },
  },
});

const email = values.email;
const password = values.password;
const name = values.name ?? email?.split("@")[0];

if (!email || !password || !name) {
  console.error("usage: admin:create --email <email> --password <password> [--name <name>] [--role <role>]");
  process.exit(1);
}

// better-auth's default minimum. Failing here with a clear message beats
// failing inside the API with a generic one.
if (password.length < 8) {
  console.error("password must be at least 8 characters");
  process.exit(1);
}

const { createAdminAuth } = await import("../src/lib/auth.ts");
const { getDb, getPool } = await import("../src/lib/db.ts");

const auth = createAdminAuth({ allowSignUp: true });

try {
  const result = await auth.api.signUpEmail({ body: { email, password, name } });
  const id = result.user.id;

  // `role` is `input: false` on the better-auth user model — server-set only,
  // never accepted from sign-up input — so it is written here rather than
  // passed above.
  if (values.role && values.role !== "admin") {
    await getDb().updateTable("admin.admin_user").set({ role: values.role }).where("id", "=", id).execute();
  }

  console.log(`created operator ${email} (${id}) with role ${values.role}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`could not create operator: ${message}`);
  process.exitCode = 1;
} finally {
  // The pool holds the process open otherwise.
  await getPool().end();
}
