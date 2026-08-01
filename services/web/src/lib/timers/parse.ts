/**
 * Step-time parser — a pure, dependency-free util that finds durations inside a
 * free-text recipe step and derives a short verb label for the timer they start
 * (plan `docs/plans/05-cook-mode.md` §10). Mirrors `recipe-scale.ts`: no React,
 * unit-tested in `parse.test.ts`, consumed by both cook-mode `StepView` and the
 * `/household/recipes/{id}` detail method list through a shared `StepText`.
 *
 * The parse is deliberately best-effort — string quantities, not structured data.
 * Known gaps, documented not fixed: temperature-adjacent false positives
 * ("350 for 25 minutes" is fine, but a bare "5–7" with no unit is ignored),
 * number words ("half an hour"), and non-English. The real fix is structured
 * durations on the recipe record (a future project, §15).
 */

/** A run of plain text between (or around) time tokens. */
export interface TextToken {
  isTime: false;
  text: string;
}

/** A tappable duration — `text` is the literal matched substring, `seconds` the
 * timer length (upper bound of a range), `label` the verb-derived timer name. */
export interface TimeToken {
  isTime: true;
  text: string;
  seconds: number;
  label: string;
}

export type StepToken = TextToken | TimeToken;

/**
 * Units we accept, word-forms only (no bare `h`/`m`/`s`) to avoid temperature
 * and stray-letter false positives. Keyed by first letter → seconds.
 */
const UNIT_ALTERNATION = "seconds?|secs?|minutes?|mins?|hours?|hrs?";
const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };

/**
 * A duration: a number (`5`, `1.5`), an optional range upper bound
 * (`5 to 7`, `5–7`, `5-7`), then a word unit. The range uses the **upper** bound
 * (`m[2] || m[1]`). Global + case-insensitive so `parseStep` can walk a step.
 */
const TIME_RE = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:(?:to|[-–—])\s*(\d+(?:\.\d+)?)\s*)?(${UNIT_ALTERNATION})\b`, "gi");

/** Verb table (base forms) — the timer's label comes from whichever appears in
 * the ~14 words before the duration. Kept as data (plan §10). */
const VERBS = [
  "bake",
  "roast",
  "simmer",
  "boil",
  "rest",
  "cool",
  "chill",
  "heat",
  "preheat",
  "brown",
  "whisk",
  "melt",
  "sauté",
  "sear",
  "steam",
  "toast",
  "fry",
  "reduce",
  "marinate",
  "knead",
  "proof",
  "soak",
  "stir",
  "cook",
  "swirl",
  "warm",
  "broil",
  "poach",
  "braise",
  "set",
] as const;

/** Noun fallback table — when no verb governs the time, name it by its vessel. */
const NOUNS = ["oven", "skillet", "pan", "batter", "dough", "butter"] as const;

const VERB_SET = new Set<string>(VERBS);
const NOUN_SET = new Set<string>(NOUNS);

/** Split a token to bare letters (drops surrounding punctuation, keeps accents). */
function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
}

/**
 * Candidate stems for a word: itself, plus suffix-stripped forms
 * (`-ing/-ed/-es/-s/-d`) each with an `-e` restore (`baking → bak → bake`).
 */
function stemsOf(word: string): string[] {
  const out = new Set<string>([word]);
  for (const suffix of ["ing", "ed", "es", "s", "d"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 2) {
      const base = word.slice(0, -suffix.length);
      out.add(base);
      out.add(base + "e");
    }
  }
  return [...out];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Derive a timer label from the text preceding a duration. Scans the last ~14
 * words nearest→furthest (the verb governing this clause's duration wins over an
 * earlier clause's): first an exact verb-stem match, then a prefix match against
 * the verb table, then a noun-table match; otherwise `"Timer"`.
 */
export function labelFor(prefixText: string): string {
  const words = prefixText.split(/\s+/).map(normalizeWord).filter(Boolean).slice(-14).reverse(); // nearest word to the duration first

  // 1. Exact verb-stem match (nearest-clause verb wins).
  for (const word of words) {
    for (const stem of stemsOf(word)) {
      if (VERB_SET.has(stem)) return capitalize(stem);
    }
  }

  // 2. Prefix match against the verb table (either direction).
  for (const word of words) {
    for (const stem of stemsOf(word)) {
      if (stem.length < 3) continue;
      for (const verb of VERBS) {
        if (verb.startsWith(stem) || stem.startsWith(verb)) return capitalize(verb);
      }
    }
  }

  // 3. Noun fallback.
  for (const word of words) {
    if (NOUN_SET.has(word)) return capitalize(word);
  }

  return "Timer";
}

/** Total seconds for a matched duration, using the range upper bound. */
function secondsFor(lower: string, upper: string | undefined, unit: string): number {
  const value = Number(upper || lower);
  const factor = UNIT_SECONDS[unit[0].toLowerCase()] ?? 1;
  return Math.round(value * factor);
}

/**
 * Split a step into text + time tokens. Non-time runs pass through verbatim; each
 * duration becomes a {@link TimeToken} carrying its seconds and a verb-derived
 * {@link labelFor} label. A step with no duration yields a single text token.
 */
export function parseStep(text: string): StepToken[] {
  const tokens: StepToken[] = [];
  let lastIndex = 0;
  TIME_RE.lastIndex = 0;

  for (let m = TIME_RE.exec(text); m !== null; m = TIME_RE.exec(text)) {
    const [matched, lower, upper, unit] = m;
    const start = m.index;
    if (start > lastIndex) {
      tokens.push({ isTime: false, text: text.slice(lastIndex, start) });
    }
    tokens.push({
      isTime: true,
      text: matched,
      seconds: secondsFor(lower, upper, unit),
      label: labelFor(text.slice(0, start)),
    });
    lastIndex = start + matched.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ isTime: false, text: text.slice(lastIndex) });
  }
  // A step that is entirely non-matching still returns one text token.
  if (tokens.length === 0) tokens.push({ isTime: false, text });
  return tokens;
}

/** Whether a step contains at least one parseable duration (cheap pre-check). */
export function hasTime(text: string): boolean {
  TIME_RE.lastIndex = 0;
  return TIME_RE.test(text);
}
