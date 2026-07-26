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
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

export default config;
