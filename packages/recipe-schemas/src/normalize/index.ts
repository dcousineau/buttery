/**
 * Vocabulary-agnostic value normalization. Every schema module coerces through
 * these so "1 hr 30 mins" and "PT1H30M" land on the same value no matter which
 * vocabulary carried it.
 */
export { cleanText, firstString, toStringList, absoluteUrl, splitLines } from "./text.ts";
export { toIsoDuration } from "./duration.ts";
