/// <reference lib="webworker" />

/**
 * Buttery's service worker (offline plan §4.4).
 *
 * **Hand-written, ~150 lines, no Workbox.** The rules below are short enough
 * that a library is more dependency than value, and — the load-bearing reason —
 * rule §2.2 has to be auditable at a glance:
 *
 *   > The service worker caches the app. TanStack Query caches the data. No
 *   > overlap.
 *
 * A service worker quietly serving stale JSON that Query believes is fresh is
 * the worst failure mode available here. So this worker never touches
 * `/_serverFn/*` or `/api/*`, and you can confirm that by reading `handle()`
 * end to end. Data staleness has exactly one owner, with one set of rules,
 * visible in one devtools panel.
 *
 * **It holds no in-memory state between events** (§9.5). iOS kills service
 * workers aggressively and restarts them cold; anything remembered in a module
 * variable is gone by the next fetch. Nothing here remembers anything.
 *
 * **It never does background work** (§9.3). Safari implements neither Background
 * Sync nor Periodic Background Sync, so M2's outbox drains from the page,
 * permanently. This worker is a static-asset cache and nothing more.
 *
 * `__SW_BUILD_ID__` and `__SW_PRECACHE__` are replaced at build time by
 * `vite-plugins/service-worker.ts`.
 */

export {}; // a module, so the injected constants below are scoped to this file

/**
 * `lib: WebWorker` types the global `self` as a plain `WorkerGlobalScope`, which
 * is the ancestor every worker kind shares — no `clients`, no `skipWaiting`, no
 * `ExtendableEvent` on the listeners. Re-declaring it is not allowed (it is a
 * `var` in the lib), so the service-worker view of the same object gets its own
 * name and everything below uses it.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Injected at build time. See `vite-plugins/service-worker.ts`.
 *
 * Two **string** scalars rather than one object, and the asset list arrives as
 * JSON text rather than an array literal, because a bundler's `define` is a
 * source-text substitution and an object or array literal is at the mercy of
 * whatever the minifier decides to do with it afterwards. (It mangled both on
 * the first attempt: the list came out comma-joined into one string and the
 * property access was folded away.) A quoted string has exactly one possible
 * reading, and the plugin asserts both landed before it lets the build pass.
 */
declare const __SW_BUILD_ID__: string;
declare const __SW_PRECACHE__: string;

const BUILD_ID = __SW_BUILD_ID__;
const PRECACHE: string[] = JSON.parse(__SW_PRECACHE__) as string[];

const CACHE = `buttery-shell-${BUILD_ID}`;

/**
 * Cross-origin recipe images, capped. These are bsky CDN URLs from
 * `blobImageUrl()`, so they are the one cross-origin thing worth holding: a
 * recipe with no hero image offline still reads, but a box of 300 grey
 * rectangles does not look like your recipe box.
 *
 * Separate cache from the shell so it can be evicted on its own — under quota
 * pressure images are the first thing that should go (§4.5).
 *
 * **The cap is a quota budget, not a byte budget.** Everything in here is an
 * *opaque* response (see `cacheImage`), and a browser cannot let a page measure
 * an opaque body — that would be a cross-origin read — so it charges each entry
 * a large fixed amount instead of its real size. Chrome's published figure is
 * ~7MB per opaque entry and WebKit does something equivalent. So the 300 this
 * started at was ~12MB of actual thumbnails and over 2GB of *accounted* quota,
 * against an iOS ceiling of roughly 1GB (§9.2) — and blowing that ceiling takes
 * the Query cache down with it, which is the thing that actually makes the app
 * work offline. 48 entries ≈ 340MB accounted, a third of the budget, images
 * degrading first exactly as §4.5 asks.
 */
const IMAGE_CACHE = "buttery-images-v1";
const IMAGE_CACHE_MAX = 48;

/** The one route precached as a data-free shell. */
const OFFLINE_SHELL = "/offline";

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      // Assets are best-effort and individual, not `addAll`: `addAll` is
      // all-or-nothing, so one hashed chunk 404ing mid-deploy would reject the
      // whole install. A worker with 103 of 104 chunks is still a useful worker.
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined)));

      // The shell is NOT best-effort. Without it every offline navigation ends
      // in `Response.error()` — the browser's own dinosaur — and the worker is
      // worse than useless, because it looks installed.
      //
      // This is not hypothetical: an install interrupted partway through left
      // exactly that worker active in testing (75 of 105 entries, no `/offline`)
      // and offline navigation failed outright. Letting the rejection escape
      // fails the install, so the browser keeps the previous working worker and
      // retries on the next load.
      await cache.add(OFFLINE_SHELL);
    })(),
  );
  // Deliberately NO `skipWaiting()`. A new worker waits until every tab running
  // the old bundle is gone, or until the page explicitly asks (see the message
  // handler). Swapping JS under a running 40-minute cook-mode timer is not
  // acceptable — `useServiceWorker` surfaces a "Reload" toast instead.
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop previous builds' shells. The image cache is versioned separately
      // and deliberately survives a deploy: the bytes are still valid and
      // re-downloading a box of images on every release is exactly the kind of
      // thing a kitchen wifi cannot afford.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith("buttery-shell-") && name !== CACHE).map((name) => caches.delete(name)));
      await sw.clients.claim();
    })(),
  );
});

/**
 * The page's way of saying "the user pressed Reload, go ahead". The only
 * message this worker understands.
 */
sw.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") void sw.skipWaiting();
});

/** Anything the worker must never touch — see §2.2. */
function isDataRequest(url: URL): boolean {
  return url.pathname.startsWith("/_serverFn") || url.pathname.startsWith("/api/");
}

/** Content-hashed build output: safe to treat as immutable. */
function isImmutableAsset(url: URL): boolean {
  return url.pathname.startsWith("/assets/") || url.pathname.startsWith("/_build/");
}

/** The manifest, icons, fonts, sounds — stable, but not content-hashed. */
function isStaticAsset(url: URL): boolean {
  return url.pathname === "/manifest.json" || url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/sounds/") || /\.(?:png|svg|ico|woff2?)$/.test(url.pathname);
}

/** Recipe hero images, from the atproto CDN. */
function isRecipeImage(url: URL): boolean {
  return url.hostname === "cdn.bsky.app";
}

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) void cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit);
  return hit ?? (await network) ?? Response.error();
}

/**
 * Recipe images, CacheFirst into a capped LRU-ish bucket of **opaque**
 * responses.
 *
 * "-ish": the trim drops the oldest *inserted* entries, which Cache Storage
 * gives us for free through key order, rather than the least recently *used*.
 * Tracking real usage would mean writing access times somewhere, and this worker
 * is not allowed to keep state (§9.5).
 *
 * **Why opaque, and why that is not a choice.** `cdn.bsky.app` sends no
 * `Access-Control-Allow-Origin` — verified against the `avatar`,
 * `feed_thumbnail`, `feed_fullsize` and `banner` presets, and against an
 * `OPTIONS` preflight: Bunny returns the bytes and no CORS header at all. So a
 * plain `<img src>` reaches this worker as `mode: "no-cors"` and `fetch` hands
 * back an opaque response: `status: 0`, `ok === false`, no headers, unreadable
 * body. The usual remedy — `crossorigin="anonymous"` on the `<img>` tags, which
 * makes the response inspectable — would turn every thumbnail request into a
 * CORS request that the CDN's *missing* header then blocks, i.e. it would break
 * every recipe image in the app, online and offline. The real choice here is
 * "cache opaque or cache nothing", and this used to be the second one: the old
 * `if (response.ok)` guard is never true for an opaque response, so this bucket,
 * its cap and its trim were all unreachable and §4.6's mirrored thumbnails
 * rendered offline as broken boxes.
 *
 * Two consequences of opacity, both accepted deliberately:
 *
 *  - **Quota padding**, priced into `IMAGE_CACHE_MAX` above.
 *  - **A CDN error is indistinguishable from a photo.** A 404 or a 502 arrives
 *    opaque too, with nothing left to test, so a thumbnail requested during a
 *    CDN blip is cached broken and stays broken until the trim reaches it. That
 *    is the price of the bucket existing at all; it is bounded by the cap, and
 *    a household that re-opens the box replaces the entry on the next miss.
 *
 * If `cdn.bsky.app` ever grows a CORS header (or `IMAGE_CDN` moves to a
 * Buttery-owned proxy, which `lib/atproto/images.ts` says is a one-constant
 * change), the better design comes back: `crossorigin="anonymous"` on the tags,
 * `response.ok` here, real byte accounting, and error responses filtered out.
 *
 * `cache.put`, not `cache.add`: `add`/`addAll` fetch and then reject anything
 * that is not `ok`, which is every opaque response. `put` is the only door.
 */
async function cacheImage(request: Request): Promise<Response> {
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // `opaque` is the expected shape; `ok` covers the day the CDN gains CORS.
  // `error` and `opaqueredirect` are the two `put` refuses outright, and a 206
  // it would throw on — none of which an `<img>` produces, but the guard is one
  // expression and a throw inside a fetch handler costs the image on screen.
  if (response.type === "opaque" || response.ok) {
    void cache.put(request, response.clone()).then(async () => {
      const keys = await cache.keys();
      if (keys.length <= IMAGE_CACHE_MAX) return;
      await Promise.all(keys.slice(0, keys.length - IMAGE_CACHE_MAX).map((key) => cache.delete(key)));
    });
  }
  return response;
}

/**
 * Navigations: network first with a 3s budget, then the precached shell.
 *
 * The response is **never cached**. SSR HTML embeds per-user state — the
 * session, the household name, the gate verdict — so a cached document is one
 * user's page served to whoever opens the app next on a shared iPad. The offline
 * fallback is `/offline`, which renders the app shell with no server data and
 * lets the client router take over at the requested URL, hydrating the route's
 * data from IndexedDB (§4.4).
 */
async function handleNavigation(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    return await fetch(request, { signal: controller.signal });
  } catch {
    // This build's shell first, then any other cache still on disk. The second
    // lookup matters during a version transition: a worker whose own precache
    // was evicted under quota pressure can still hand over a previous build's
    // shell, and an old shell that boots the client router is a better answer
    // than a browser error page.
    const cache = await caches.open(CACHE);
    const shell = (await cache.match(OFFLINE_SHELL)) ?? (await caches.match(OFFLINE_SHELL));
    return shell ?? Response.error();
  } finally {
    clearTimeout(timeout);
  }
}

function handle(request: Request): Promise<Response> | null {
  const url = new URL(request.url);

  // §2.2, first and unconditional: server functions and auth are network-only,
  // in both directions. Returning null hands the request straight to the
  // browser, so it is not merely uncached — this worker is not in its path.
  if (isDataRequest(url)) return null;

  // `no-cors` only — which is what an `<img src>` without a `crossorigin`
  // attribute produces, and the only shape this bucket holds. Handing a cached
  // *opaque* response back to a request that asked for `cors` is a network
  // error by spec, so anything that ever fetches a CDN image deliberately (a
  // canvas export, a share-sheet thumbnail) has to go straight to the network
  // rather than get a broken response out of here.
  if (isRecipeImage(url)) return request.mode === "no-cors" ? cacheImage(request) : null;

  // Everything else cross-origin (PostHog, the atproto PDS, OAuth hops) is
  // none of this worker's business.
  if (url.origin !== sw.location.origin) return null;

  if (request.mode === "navigate") return handleNavigation(request);
  if (isImmutableAsset(url)) return cacheFirst(request, CACHE);
  if (isStaticAsset(url)) return staleWhileRevalidate(request);
  return null;
}

sw.addEventListener("fetch", (event) => {
  // Only GET. A cached POST is a contradiction, and Cache Storage refuses to
  // store one anyway.
  if (event.request.method !== "GET") return;
  const response = handle(event.request);
  if (response) event.respondWith(response);
});
