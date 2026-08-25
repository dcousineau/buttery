/**
 * Shared text normalization for the food lexicon.
 *
 * This lives in its own module, apart from `categorize.ts`, for one reason: the
 * build-time generator (`scripts/build-food-lexicon.ts`) has to normalize the
 * lexicon's index keys with the *exact* function the runtime matcher looks them
 * up with, and it cannot import `categorize.ts` — that module imports the
 * lexicon the generator is in the middle of writing.
 *
 * Change anything here and the lexicon must be regenerated, or lookups that
 * used to hit will start missing.
 */

/**
 * Lowercase, strip diacritics and punctuation, collapse whitespace.
 *
 * Hyphens and slashes become spaces rather than vanishing, so `half-and-half`
 * normalizes to `half and half` instead of `halfandhalf`.
 */
export function normalizeFoodName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The Open Food Facts id form of a name: normalized, then hyphen-joined.
 * `Chicken Breast` → `chicken-breast`, which with its language prefix is the
 * canonical id `en:chicken-breast`.
 */
export function slugifyFoodName(input: string): string {
  return normalizeFoodName(input).replace(/ /g, "-");
}

/**
 * Naive English singularization, used as the second step of the match cascade.
 * Deliberately conservative — it only has to undo the plural forms that show up
 * in recipe ingredient lines, and a wrong guess costs a missed match, which is
 * cheap, rather than a wrong merge, which is not.
 */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ch|sh|x|z|s)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (word.endsWith("ves")) return `${word.slice(0, -3)}f`;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Singularize the final word of a phrase — the head noun carries the plural. */
export function singularizePhrase(phrase: string): string {
  const words = phrase.split(" ");
  if (words.length === 0) return phrase;
  words[words.length - 1] = singularize(words[words.length - 1]);
  return words.join(" ");
}
