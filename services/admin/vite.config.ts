import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Server-side config (DATABASE_URL, ADMIN_BETTER_AUTH_SECRET, ADMIN_APP_URL)
// comes from this package's `.env`, loaded here into process.env — the same
// thing `services/web/vite.config.ts` does, for the same reason: Vite only
// loads `VITE_`-prefixed vars on its own. No-op when the file is absent, and it
// never overrides a var that is already set.
try {
  process.loadEnvFile();
} catch {
  // No .env present — rely on the ambient environment.
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // The admin runs beside the app's dev server (127.0.0.1:3000), never instead
  // of it. Same host binding for the same reason — an IPv4-only bind keeps
  // `127.0.0.1` and `localhost` from resolving to two different servers.
  // `strictPort` so a busy 3100 is a loud failure rather than a silent move to
  // 3101: process-compose's readiness probe checks 3100 by name, and a server
  // that quietly relocates reads as "never became ready" while sitting there
  // perfectly healthy on the wrong port.
  server: { host: "127.0.0.1", port: 3100, strictPort: true },
  plugins: [
    tailwindcss(),
    tanstackStart({
      // Server-only modules that must never be pulled into a client chunk. A
      // client bundle that imports `lib/db.ts` ships `pg`; one that imports
      // `lib/auth.ts` ships the session secret's read site.
      importProtection: {
        enabled: true,
        behavior: "mock",
        client: { files: ["**/*.server.*", "src/lib/db.ts", "src/lib/auth.ts"] },
      },
    }),
    viteReact(),
  ],
});

export default config;
