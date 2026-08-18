import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Local dev reads server-side config (DATABASE_URL, REDIS_URL, BLOB_S3_*, the
// ATPROTO_* overrides, …) from this package's `.env` into process.env — the
// same thing kysely.config.ts does for the migration CLI. It used to arrive via
// `railway run`, which `pnpm dev` no longer wraps the server in. Vite already
// loads `.env` for `VITE_`-prefixed client vars; this covers the server vars it
// leaves untouched. No-op when the file is absent (the Railway production build,
// where the environment is already populated), and it never overrides a var
// that is already set — so `railway run`, CI, and shell exports still win.
try {
  process.loadEnvFile();
} catch {
  // No .env present — rely on the ambient environment.
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // @buttery/lexicons ships raw generated TypeScript (no build step); force Vite
  // to transpile it for the SSR bundle instead of externalizing it from node_modules.
  ssr: { noExternal: ["@buttery/lexicons"] },
  // resvg is a native binding, loaded server-side only via a lazy
  // `import("@resvg/resvg-js")` for OG-image rendering. The client dependency
  // optimizer has no business scanning it, and on linux-x64 it dies trying:
  // `[UNLOADABLE_DEPENDENCY] … stream did not contain valid UTF-8`, which takes
  // the whole dev server down. Never reproduces on ARM macOS, hence the note.
  optimizeDeps: { exclude: ["@resvg/resvg-js"] },
  // Bind IPv4 explicitly: the atproto loopback OAuth client redirects the app
  // to 127.0.0.1, but plain `localhost` may resolve to ::1 only.
  server: { host: "127.0.0.1" },
  plugins: [
    devtools({
      // Console piping is bidirectional — client logs go to the terminal AND
      // server logs go to the browser console — which makes it a feedback loop
      // rather than a pipe. Anything the client logs comes back as a server
      // log, is logged again with `[Server] [vite] (client) …` prepended, and
      // goes around again; the line grows by a prefix per round trip until the
      // dev server dies of heap exhaustion. It really does: a single React
      // hydration error took it out in about two minutes, taking port 3000
      // hostage with an orphaned vite. Server logs still reach the terminal,
      // where they belong; the browser console still has the client's own.
      consolePiping: { enabled: false },
    }),
    tailwindcss(),
    tanstackStart({
      importProtection: {
        enabled: true,
        behavior: "mock",
        client: {
          files: ["**/*.server.*", "src/lib/db.ts", "src/lib/posthog-server.ts", "src/lib/net/safe-fetch.ts", "src/server/household/ids.ts"],
        },
      },
    }),
    viteReact(),
  ],
});

export default config;
