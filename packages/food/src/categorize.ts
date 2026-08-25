/**
 * Match a parsed ingredient name to a food, and through it to an aisle (plan §4.3).
 *
 * Pure, dependency-free, no DB and no DOM, so the identical module runs inside a
 * server function and inside the browser. The lexicon arrives through a dynamic
 * `import()` so it lands in its own lazy chunk rather than in the entry bundle.
 *
 * ## The cascade, first hit wins
 *
 * 1. Normalized exact lookup.
 * 2. Naive singularization, retry.
 * 3. Left-trim modifiers — drop leading tokens one at a time and retry.
 * 4. Longest contiguous token span that is a known food (subsumes head-noun
 *    suffix matching, and reaches trailing prep clauses left-trim cannot).
 * 5. Fuzzy, dice coefficient over bigrams, at a **deliberately high threshold**.
 * 6. Miss.
 *
 * ## Why step 5's threshold is so high
 *
 * The failure this whole module exists to avoid is not a missed match. A miss is
 * cheap: the line still parses, still consolidates with an identical line from
 * another recipe by normalized name, and lands in `other`. The expensive failure
 * is a *wrong* match, because a wrong match silently **merges two different
 * foods into one row** and you find out at the store with the wrong bag.
 *
 * `chicken breast` and `chicken thigh` share a great many bigrams. So do `red
 * onion` and `green onion`. At 0.9, restricted to candidates sharing a first
 * letter, step 5 catches `chicekn breast` and refuses to guess at anything else.
 * `categorize.test.ts` pins those non-matches explicitly.
 */

import { type Aisle, DEFAULT_AISLE } from "./aisles";
import { normalizeFoodName, singularizePhrase } from "./normalize";

export interface LexiconFood {
  /** Aisle. */
  a: Aisle;
  /** Canonical display name. */
  n: string;
  /** Staple — shown in the add preview but unchecked (plan D9). */
  s?: 1;
  /** Ignored — dropped from the add preview entirely. */
  x?: 1;
}

export interface Lexicon {
  __meta: Record<string, unknown>;
  foods: Record<string, LexiconFood>;
  /** Normalized name → food id. Holds every synonym, not just canonical names. */
  index: Record<string, string>;
}

export interface FoodMatch {
  /** Open Food Facts id, e.g. `en:chicken-breast`. `null` when nothing matched. */
  foodSlug: string | null;
  /** Normalized identity. The merge key when `foodSlug` is `null` (plan D6). */
  nameNorm: string;
  aisle: Aisle;
  /** Shown in the preview but unchecked by default. */
  isStaple: boolean;
  /** Never shopped for — dropped from a recipe-derived preview. */
  isIgnored: boolean;
  /** Which cascade step produced the hit. Diagnostics and calibration only. */
  via: "exact" | "singular" | "trimmed" | "suffix" | "fuzzy" | "miss";
}

/** The fuzzy threshold. See the module doc for why it is not lower. */
const FUZZY_THRESHOLD = 0.9;

/** Below this many characters, fuzzy matching is noise — `oil` vs `oat`. */
const FUZZY_MIN_LENGTH = 6;

let cached: Lexicon | null = null;
let loading: Promise<Lexicon> | null = null;

/**
 * Load the lexicon, once. Dynamic so the ~500KB of JSON stays out of the entry
 * bundle and out of any server response that never categorizes anything.
 */
export async function loadLexicon(): Promise<Lexicon> {
  if (cached) return cached;
  loading ??= import("./lexicon.json", { with: { type: "json" } }).then((module) => {
    cached = (module.default ?? module) as unknown as Lexicon;
    return cached;
  });
  return loading;
}

/** Inject a lexicon directly. Tests and the calibration script use this. */
export function setLexicon(lexicon: Lexicon): void {
  cached = lexicon;
  loading = Promise.resolve(lexicon);
}

/** The fuzzy pass needs the index keys bucketed by first letter; build once. */
const keyCache = new WeakMap<Lexicon, { keys: string[]; byFirstLetter: Map<string, string[]> }>();

function indexKeys(lexicon: Lexicon): { keys: string[]; byFirstLetter: Map<string, string[]> } {
  const hit = keyCache.get(lexicon);
  if (hit) return hit;

  const keys = Object.keys(lexicon.index).sort((a, b) => b.length - a.length);
  const byFirstLetter = new Map<string, string[]>();
  for (const key of keys) {
    const letter = key[0] ?? "";
    const bucket = byFirstLetter.get(letter);
    if (bucket) bucket.push(key);
    else byFirstLetter.set(letter, [key]);
  }

  const built = { keys, byFirstLetter };
  keyCache.set(lexicon, built);
  return built;
}

function resolve(lexicon: Lexicon, id: string, nameNorm: string, via: FoodMatch["via"]): FoodMatch {
  const food = lexicon.foods[id];
  if (!food) return miss(nameNorm);
  return {
    foodSlug: id,
    nameNorm,
    aisle: food.a,
    isStaple: food.s === 1,
    isIgnored: food.x === 1,
    via,
  };
}

function miss(nameNorm: string): FoodMatch {
  return { foodSlug: null, nameNorm, aisle: DEFAULT_AISLE, isStaple: false, isIgnored: false, via: "miss" };
}

/**
 * Run the cascade against an already-loaded lexicon.
 *
 * Synchronous, so `merge.ts` can categorize a whole recipe without an await per
 * line. Callers that have not loaded the lexicon yet want {@link categorize}.
 */
export function categorizeWith(lexicon: Lexicon, rawName: string): FoodMatch {
  const nameNorm = normalizeFoodName(rawName);
  if (!nameNorm) return miss(nameNorm);

  // 1. exact
  const exact = lexicon.index[nameNorm];
  if (exact) return resolve(lexicon, exact, nameNorm, "exact");

  // 2. singularized
  const singular = singularizePhrase(nameNorm);
  if (singular !== nameNorm) {
    const hit = lexicon.index[singular];
    if (hit) return resolve(lexicon, hit, nameNorm, "singular");
  }

  // 3. left-trim modifiers, one token at a time:
  //    `boneless skinless chicken breasts` → `skinless chicken breasts` → …
  const words = singular.split(" ");
  for (let i = 1; i < words.length; i++) {
    const tail = words.slice(i).join(" ");
    const hit = lexicon.index[tail];
    if (hit) return resolve(lexicon, hit, nameNorm, "trimmed");
  }

  const { byFirstLetter } = indexKeys(lexicon);

  // 4. Longest contiguous token span that is a known food.
  //
  //    Step 3 trims from the left, which reaches a head noun buried under
  //    modifiers. What it cannot reach is anything with words AFTER the food,
  //    and calibration against the real corpus showed that is the single
  //    biggest source of misses: `garlic, smashed`, `ripe tomatoes, cut into
  //    large chunks`, `feta, crumbled`. Normalization has already turned those
  //    commas into spaces by the time we get here, so the trailing clause looks
  //    exactly like more of the name.
  //
  //    Enumerating every prep participle in `parse.ts` would be a losing game —
  //    recipes write "stems discarded, caps thickly sliced". Searching spans
  //    instead asks the lexicon rather than a word list, and it subsumes the
  //    head-noun suffix case the plan specified.
  //
  //    Longest length first, and within a length LEFT to right. Longest-first is
  //    what makes `boneless skinless chicken thighs cut into pieces` find
  //    `chicken thigh` at length 2 rather than falling back to `thigh`.
  //    Left-to-right is what keeps a prep word from winning: scanning from the
  //    right, `sweet Italian sausage, casings removed` matched `en:casing`
  //    before it ever reached `sausage`. Leading modifiers are step 3's job, so
  //    by the time we are here the food is to the LEFT of the junk.
  for (const phrase of nameNorm === singular ? [singular] : [singular, nameNorm]) {
    const tokens = phrase.split(" ");
    if (tokens.length < 2) continue;
    for (let length = tokens.length - 1; length >= 1; length--) {
      for (let start = 0; start + length <= tokens.length; start++) {
        const span = tokens.slice(start, start + length).join(" ");
        const hit = lexicon.index[span] ?? lexicon.index[singularizePhrase(span)];
        if (hit) return resolve(lexicon, hit, nameNorm, "suffix");
      }
    }
  }

  // 5. fuzzy, same first letter only, high bar. Typos, not guesses.
  if (singular.length >= FUZZY_MIN_LENGTH) {
    const candidates = byFirstLetter.get(singular[0] ?? "") ?? [];
    let best = "";
    let bestScore = 0;
    for (const candidate of candidates) {
      // A length gap that large cannot survive the threshold anyway; skipping it
      // keeps this pass linear in practice rather than in principle.
      if (Math.abs(candidate.length - singular.length) > 3) continue;
      const score = diceCoefficient(singular, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (bestScore >= FUZZY_THRESHOLD && best) {
      const hit = lexicon.index[best];
      if (hit) return resolve(lexicon, hit, nameNorm, "fuzzy");
    }
  }

  // 6. miss. A null-slug row never merges with a slug row (plan D6).
  return miss(nameNorm);
}

/** Load the lexicon if needed, then run the cascade. */
export async function categorize(rawName: string): Promise<FoodMatch> {
  return categorizeWith(await loadLexicon(), rawName);
}

/**
 * Sørensen–Dice coefficient over character bigrams: `2·|A∩B| / (|A|+|B|)`.
 * Multiset intersection, so a repeated bigram counts as many times as it occurs
 * in both — otherwise `banana` scores misleadingly well against everything with
 * an `an` in it.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    const remaining = counts.get(bigram) ?? 0;
    if (remaining > 0) {
      counts.set(bigram, remaining - 1);
      intersection += 1;
    }
  }

  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}
