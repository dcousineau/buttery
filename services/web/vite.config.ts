import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // @buttery/lexicons ships raw generated TypeScript (no build step); force Vite
  // to transpile it for the SSR bundle instead of externalizing it from node_modules.
  ssr: { noExternal: ["@buttery/lexicons"] },
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
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
