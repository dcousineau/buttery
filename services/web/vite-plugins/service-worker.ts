import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build, type Plugin } from "vite";

/**
 * Builds `src/sw.ts` into `dist/client/sw.js` (offline plan §4.4).
 *
 * **Why a local plugin and not `vite-plugin-pwa` or Serwist.** Both hook the
 * Vite build step that TanStack Start's plugin replaces — Start runs its own
 * client and server passes, and neither library's `generateSW`/`injectManifest`
 * ever fires. The consensus workaround in TanStack/router#4770 is exactly this:
 * a small plugin that runs a second build in `closeBundle`. srvx serves
 * `dist/client` statically, so the output path is simply the client root — which
 * is what gives the worker the `/` scope it needs to control every navigation.
 *
 * The second pass is Vite's own `build()` with `configFile: false`, so the
 * worker gets real TypeScript handling from the toolchain already in the tree
 * and this plugin adds no dependency. It cannot recurse: the inline config
 * declares no plugins, so this one is not part of it.
 *
 * **No-op in dev** (`apply: "build"`). A service worker in dev intercepts HMR,
 * serves yesterday's chunks after a restart, and generally makes "did my change
 * apply?" unanswerable. Offline behaviour is verified against production builds,
 * which is what §4.7's acceptance list asks for anyway.
 */
export function serviceWorker(): Plugin {
  let outDir: string | null = null;

  return {
    name: "buttery:service-worker",
    apply: "build",

    configResolved(config) {
      // Start emits both a client and a server bundle. Only the client one has
      // any business owning a service worker, and only it is served statically.
      if (config.build.ssr) return;
      // `config.build.outDir` is NOT absolute — Vite leaves it as authored and
      // resolves it against `config.root` at every use site (`getResolvedOutDirs`).
      // Captured raw it silently resolved against `process.cwd()` instead, which
      // is the same directory only because `pnpm --filter @buttery/web build`
      // happens to chdir into the package. Run the build from the repo root, or
      // from a workspace script that does not, and this plugin would read an
      // empty `dist/client/assets` and emit a worker that caches nothing.
      outDir = resolve(config.root, config.build.outDir);
    },

    async closeBundle() {
      if (!outDir) return;
      const clientOutDir = outDir;

      const assets = await collectAssets(clientOutDir).catch((cause: unknown) => {
        throw new Error(`service worker: could not read ${join(clientOutDir, "assets")} — the client build did not emit where this plugin looks.`, { cause });
      });
      // An empty asset list is a hard build error, never a quiet `[]`.
      //
      // This is the exact case the injection assertion at the bottom of this
      // function exists for, and until now it was the one case that assertion
      // could not see: `collectAssets` swallowed a missing/renamed `assets/`
      // directory, the empty list hashed to sha256("") — the constant
      // `e3b0c44298fc`, identical on every build, so the shell cache name never
      // rotates and `activate`'s eviction never fires — and the precache check
      // below was guarded by `assets[0] &&`, so it skipped itself. The result is
      // a worker that installs, activates, looks correct in devtools, precaches
      // nothing, and serves a stale shell forever. You find that out on a phone
      // in a shop, which is precisely what the offline plan exists to prevent.
      const [firstAsset] = assets;
      if (!firstAsset) {
        throw new Error(
          `service worker: no JS/CSS assets found under ${join(clientOutDir, "assets")} — the client build emitted nothing to precache, so the worker would be a no-op.`,
        );
      }

      // A content hash over the emitted asset list, so the cache name changes
      // exactly when the app does. A timestamp would mint a new cache — and pop
      // a "New version available" toast — on every rebuild of identical output.
      const buildId = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);

      await build({
        configFile: false,
        logLevel: "warn",
        // Scalars, and the asset list as JSON *text*. See the matching note in
        // `src/sw.ts`: `define` is a text substitution, so anything richer than
        // a quoted string is at the mercy of the minifier that runs after it.
        define: {
          __SW_BUILD_ID__: JSON.stringify(buildId),
          __SW_PRECACHE__: JSON.stringify(JSON.stringify(assets)),
        },
        build: {
          outDir: clientOutDir,
          // The app's own output is already sitting here.
          emptyOutDir: false,
          // A worker is not a library, but `lib` mode is how you ask Vite for a
          // single self-contained file at a name you choose. `iife` because a
          // service worker has no module loader unless it is registered as one,
          // and registering a module worker rules out older Safari.
          lib: { entry: join(import.meta.dirname, "../src/sw.ts"), formats: ["iife"], name: "butterySw", fileName: () => "sw.js" },
          rollupOptions: {
            // The worker imports nothing, on purpose. If that ever changes, this
            // is the line that will say so — loudly — rather than silently
            // inlining a dependency into a file that runs outside the page.
            external: [],
          },
        },
      });

      // Assert the injection landed. A worker whose precache list silently
      // became one comma-joined string, or whose build id folded away, still
      // registers, still activates, and still looks fine in devtools — it just
      // caches nothing, and you find out on a phone in a store. That failure is
      // exactly what the offline plan exists to prevent, so it fails the build.
      const emitted = await readFile(join(clientOutDir, "sw.js"), "utf8");
      if (!emitted.includes(buildId)) throw new Error("service worker: the build id was not injected — check the `define` in this plugin against `src/sw.ts`.");
      // Unconditional: `firstAsset` is non-empty by the throw above, so there is
      // no `assets[0] &&` left for the assertion to opt itself out through.
      if (!emitted.includes(firstAsset)) {
        throw new Error("service worker: the precache list was not injected — check the `define` in this plugin against `src/sw.ts`.");
      }

      this.info?.(`service worker → ${join(clientOutDir, "sw.js")} (${assets.length} precached assets, build ${buildId})`);
    },
  };
}

/**
 * Everything under `assets/` worth precaching.
 *
 * Deliberately not *every* emitted file: source maps are large and never
 * requested by a user, and precaching them would spend a phone's storage budget
 * on debugging artifacts. JS and CSS are what a cold offline start needs.
 *
 * Failures are **not** swallowed. The previous `.catch(() => undefined)` turned
 * "the directory Vite emits into moved" — a real, silent, one-upgrade-away
 * failure — into an empty list, and an empty list is a worker that caches
 * nothing while looking installed. Let the `ENOENT` out; the caller turns it
 * into a build error naming the path it looked in.
 */
async function collectAssets(outDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.name.endsWith(".map")) continue;
      if (!/\.(?:js|css)$/.test(entry.name)) continue;
      found.push("/" + relative(outDir, full).split(/[\\/]/).join("/"));
    }
  }

  await walk(join(outDir, "assets"));
  return found.sort();
}
