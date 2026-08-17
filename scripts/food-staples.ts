/**
 * Staple and ignored foods, by Open Food Facts taxonomy id.
 *
 * Both maps are resolved the same way the aisle map is: the build script walks
 * a food's ancestors and takes the **nearest** mapped one. That is why they are
 * `Record<string, boolean>` and not lists — a `false` entry on a deeper node
 * carves an exception out of a broader `true` one, so `en:oil-and-fat` can be a
 * staple without dragging `en:coconut-oil` along with it.
 *
 * STAPLES are the things a kitchen already has. They still appear in the
 * add-to-list preview (plan D9) so nothing is silently dropped, but they arrive
 * *unchecked* — the common case is that you are not buying more salt.
 *
 * IGNORED lines are never shopped for at all, so they are left out of the
 * preview entirely. Only recipe-derived lines are filtered this way; a manually
 * typed item is always honoured, because typing "water" is a deliberate act.
 */

/** Foods shown in the add preview but unchecked by default. Nearest node wins. */
export const STAPLE_NODES: Record<string, boolean> = {
  "en:salt": true,
  "en:pepper": true,
  "en:spice": true,
  "en:flavouring": true,
  "en:oil-and-fat": true,
  "en:vinegar": true,
  "en:sugar": true,
  "en:added-sugar": true,
  "en:flour": true,
  "en:baking-powder": true,
  "en:yeast": true,
  "en:starch": true,
  "en:corn-starch": true,
  "en:vanilla-extract": true,
  "en:honey": true,

  // Carve-outs. These live under a staple node but are a real shopping line:
  // nobody keeps a standing supply of them the way they keep salt.
  "en:butter": false,
  "en:margarine": false,
  "en:coconut-oil": false,
  "en:sesame-oil": false,
  "en:maple-syrup": false,
  "en:balsamic-vinegar": false,
};

/** Lines dropped from the add preview outright. Nearest node wins. */
export const IGNORED_NODES: Record<string, boolean> = {
  "en:water": true,
  "en:ice": true,

  // Bought, not poured from the tap.
  "en:carbonated-water": false,
  "en:mineral-water": false,
  "en:coconut-water": false,
};
