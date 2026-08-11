/**
 * Buttery bookmarklet loader (docs/plans/2026-08-02-create-recipes.md §C1).
 *
 * This is the "bundle" the tiny `javascript:` bookmarklet injects as a <script>
 * from our own origin (served by routes/bookmarklet[.]js.ts, which substitutes
 * the real origin for `__BUTTERY_ORIGIN__` at request time). Keeping the logic
 * here — not inline in the bookmarklet href — means we can ship fixes without
 * anyone re-dragging the bookmarklet.
 *
 * It does NO recipe parsing. On a recipe page it does the simplest thing:
 *   - find schema.org JSON-LD and send that, else send the page's raw HTML,
 * then hands the payload to an authenticated same-origin Buttery bridge tab via
 * postMessage. The bridge (signed in, same-origin) calls the server, which runs
 * the one shared extractor and returns an import id. No cross-origin POST, no
 * session cookie on the hostile page, no browser copy of the parser to keep in sync.
 *
 * Authored as plain browser JS (no build step, no imports) so it runs as-is.
 */
/* oxlint-disable no-undef -- runs in the hostile page's browser, not our bundle. */
/* oxlint-disable no-var -- no build step, so this ships as authored; `var` is the widest-support declaration. */
(function () {
  "use strict";

  var ORIGIN = "__BUTTERY_ORIGIN__";
  var BRIDGE_URL = ORIGIN + "/household/recipes/import-bridge";
  var READY = "buttery-import-ready";
  var PAYLOAD = "buttery-import-payload";

  // Guard against a double-click running two copies on the same page.
  if (window.__butteryImportRunning) return;
  window.__butteryImportRunning = true;

  // --- 1. Collect the payload -------------------------------------------------

  // Does a parsed JSON-LD value (object, array, or @graph) describe a Recipe?
  function hasRecipe(node) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) if (hasRecipe(node[i])) return true;
      return false;
    }
    var t = node["@type"];
    if (t === "Recipe" || (Array.isArray(t) && t.indexOf("Recipe") !== -1)) return true;
    if (node["@graph"]) return hasRecipe(node["@graph"]);
    return false;
  }

  var payload = null;
  var blocks = document.querySelectorAll('script[type="application/ld+json"]');
  for (var b = 0; b < blocks.length; b++) {
    var text = blocks[b].textContent || "";
    if (!text.trim()) continue;
    try {
      if (hasRecipe(JSON.parse(text))) {
        payload = { url: location.href, jsonld: text };
        break;
      }
    } catch {
      // Malformed JSON-LD block — skip it and keep looking.
    }
  }
  // No recipe JSON-LD anywhere → ship the raw HTML; the server extractor handles it.
  if (!payload) {
    payload = { url: location.href, html: document.documentElement.outerHTML };
  }

  // --- 2. Open the authenticated bridge tab and hand off the payload ----------

  var bridge = window.open(BRIDGE_URL, "buttery_import");
  if (!bridge) {
    window.__butteryImportRunning = false;
    // The user's own click, on their own page — a one-line prompt is fine here.
    alert("Buttery couldn't open a tab. Allow pop-ups for this site, then click Save to Buttery again.");
    return;
  }

  // The bridge polls us with READY until it has the payload; reply to each one
  // (idempotent) so neither a slow tab load nor an early post loses the handoff.
  window.addEventListener("message", function (e) {
    if (e.source !== bridge) return; // only our bridge tab
    if (e.origin !== ORIGIN) return; // only our origin
    if (!e.data || e.data.type !== READY) return;
    bridge.postMessage({ type: PAYLOAD, payload: payload }, ORIGIN);
  });
})();
