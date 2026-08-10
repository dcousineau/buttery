/**
 * Bulk attribution grouping (plan §8), and the two string affordances the design took off
 * the optional list (§10.2): the `pg 174` title/page split and the "looks like a
 * misspelling of one above" hint.
 *
 * Generic by construction. The whole input is `ImportCandidate.sourceText` for every
 * candidate whose `sourceUrl` is null; nothing here asks which app produced them. Every
 * recipe-manager export has this shape — a free-text "where this came from" field that is
 * not a lexicon attribution — so this is the pipeline step most likely to pay off on the
 * second importer unchanged.
 *
 * Both affordances are hints. Neither merges strings, and neither answers on the user's
 * behalf (§8.2: never auto-invent attribution).
 */

// The machine owns the *answer* (`GroupChoice`); this module owns the *question* (the
// groups). The import is type-only and therefore erased, so naming the answer's shape here
// costs no runtime edge back to `machine.ts` — and it means the field list below cannot
// drift from the interface it enumerates.
import type { AttributionKind, GroupChoice } from "./machine.ts";

/**
 * The synthetic key for the recipes that name neither a link nor a source (§8.2).
 *
 * The leading NUL is what keeps it from ever colliding with a real source string — group
 * keys are verbatim user text, and a plain `"no-source"` is a book someone could own.
 * Written as the `\u0000` **escape**, never as a literal 0x00 byte in this file: a raw NUL
 * makes git classify the whole module as binary, and a file that never appears in a diff is
 * a file nobody reviews.
 */
export const NO_SOURCE_GROUP_KEY = "\u0000no-source";

/** Similarity at or above which two source strings are surfaced as possible misspellings. */
export const MISSPELLING_THRESHOLD = 0.8;

/**
 * The three fields grouping reads. Structural rather than `ImportCandidate` so the machine
 * can group the items it already holds instead of retaining a second copy of every recipe
 * body for the life of the session — and so a test fixture is three fields, not a recipe.
 */
export interface GroupableCandidate {
  clientId: string;
  sourceUrl: string | null;
  sourceText: string | null;
}

export interface SourceGroup {
  /** Stable identity for the group. The verbatim source string, or {@link NO_SOURCE_GROUP_KEY}. */
  key: string;
  /**
   * The verbatim source string, preserved exactly as the export wrote it — this is what
   * lands in the sidecar under `key='source_text'` regardless of what the user chooses
   * (§8.2). `null` is the 29th group: neither a URL nor a source string.
   */
  sourceText: string | null;
  /** Every candidate using this exact string, in parse order. */
  clientIds: string[];
  /**
   * Publication-title prefill from the page-reference split: `"Ottolenghi Simple pg 174"`
   * prefills `"Ottolenghi Simple"`. Empty for the no-source group.
   */
  titlePrefill: string;
  /**
   * The trailing page reference the split removed (`"pg 174"`), or null. The page reference
   * is **not lost** — `source_text` keeps the whole string verbatim — and this field is
   * what lets the UI say so ("page reference will be kept on the recipes").
   */
  pageReference: string | null;
  /**
   * Key of an **earlier** group this one reads like a misspelling of, or null. A hint the
   * UI renders as a line of text; it never merges the groups and never pre-answers one.
   */
  similarTo: string | null;
}

/**
 * The same groups, narrowed to the recipes that are still going to be written.
 *
 * `buildSourceGroups` runs at `parse_complete`, before any verdict exists, so it groups
 * every URL-less candidate in the drop. By review time some of those are skipped — a
 * re-import of the same folder skips nearly all of them — and an attribution question about
 * a recipe nobody is saving is not a question. This drops those recipes from their group,
 * and drops any group left with no one in it, so the count of unanswered groups (the commit
 * gate) and the cards the user is shown are the same set.
 *
 * `similarTo` is cleared when the group it pointed at is gone: "looks like a misspelling of
 * one above" is a literal instruction, and it must not point at a card that is not there.
 */
export function liveSourceGroups(groups: readonly SourceGroup[], isLive: (clientId: string) => boolean): SourceGroup[] {
  const live: SourceGroup[] = [];
  for (const group of groups) {
    const clientIds = group.clientIds.filter(isLive);
    if (!clientIds.length) continue;
    live.push(clientIds.length === group.clientIds.length ? group : { ...group, clientIds });
  }
  const keys = new Set(live.map((group) => group.key));
  return live.map((group) => (group.similarTo && !keys.has(group.similarTo) ? { ...group, similarTo: null } : group));
}

/**
 * Strip a trailing page reference from a source string (§8.1).
 *
 * Deliberately conservative: only a `pg`/`pgs`/`p`/`pp`/`page(s)` token followed by digits
 * at the very end of the string, optionally after a comma or dash. `"Ottolenghi Simple"`
 * with no page reference comes back unchanged, and a title that genuinely ends in a number
 * (`"Cook's Illustrated 2019"`) is untouched because the number is not preceded by a page
 * word.
 */
export function splitPageReference(raw: string): { title: string; page: string | null } {
  const text = raw.trim();
  const match = /^(.*?)[\s,–—-]*\b((?:pgs?|pp?|pages?)\.?\s*\d+(?:\s*[-–—]\s*\d+)?)\s*$/i.exec(text);
  if (!match) return { title: text, page: null };
  const title = match[1].trim();
  // A string that is *only* a page reference has no title to prefill; keep it whole.
  if (!title) return { title: text, page: null };
  return { title, page: match[2].trim() };
}

/** Case- and punctuation-insensitive form used for the similarity comparison only. */
function comparisonForm(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Classic Levenshtein distance, two-row rolling buffer. Inputs here are ≤ ~60 chars. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Normalized Levenshtein similarity in `[0, 1]`. 1 is identical.
 *
 * §8.1 allows "normalized Levenshtein ≥ 0.8 (or a trigram ratio)"; this is the former,
 * over the comparison form so that `"Godon Ramsey ROmsay's"` and
 * `"Gordon Ramsey Heathly Appettie"` are compared on letters rather than on capitalization.
 */
export function stringSimilarity(a: string, b: string): number {
  const x = comparisonForm(a);
  const y = comparisonForm(b);
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(x, y) / longest;
}

/**
 * Group every URL-less candidate by its **exact** source string (§8.1).
 *
 * Exact, not normalized: the six Gordon Ramsay spellings are separate strings on purpose so
 * the user can map all six onto one publication and the misspellings never reach a record.
 * Merging them here would be the tool answering for them.
 *
 * The 29th group — candidates with neither a URL nor a source string — is a group like any
 * other, carrying the same four controls (§8.2, §10.3: the comp's controls-less card is an
 * oversight, not a decision).
 *
 * Groups are ordered by descending recipe count, then by first appearance, so the decisions
 * that cover the most recipes come first and the "misspelling of one above" hint points
 * backwards — at a group the user has already seen.
 */
export function buildSourceGroups(candidates: readonly GroupableCandidate[]): SourceGroup[] {
  const byKey = new Map<string, { sourceText: string | null; clientIds: string[]; firstSeen: number }>();

  candidates.forEach((candidate, index) => {
    if (candidate.sourceUrl) return; // recipes with a URL get server-built attributionWebsite (§8.2)
    const text = candidate.sourceText?.trim() ? candidate.sourceText : null;
    const key = text ?? NO_SOURCE_GROUP_KEY;
    const existing = byKey.get(key);
    if (existing) existing.clientIds.push(candidate.clientId);
    else byKey.set(key, { sourceText: text, clientIds: [candidate.clientId], firstSeen: index });
  });

  const ordered = [...byKey.entries()].sort((a, b) => b[1].clientIds.length - a[1].clientIds.length || a[1].firstSeen - b[1].firstSeen);

  const groups: SourceGroup[] = ordered.map(([key, value]) => {
    const split = value.sourceText ? splitPageReference(value.sourceText) : { title: "", page: null };
    return { key, sourceText: value.sourceText, clientIds: value.clientIds, titlePrefill: split.title, pageReference: split.page, similarTo: null };
  });

  // Misspelling hint: ≤28 distinct strings in the reference export, so the pairwise pass is
  // free. Each group points at the FIRST earlier group it resembles — "one above" is a
  // literal instruction to the reader, so the hint must never point forwards.
  for (let i = 0; i < groups.length; i++) {
    const self = groups[i];
    if (!self.sourceText) continue;
    for (let j = 0; j < i; j++) {
      const other = groups[j];
      if (!other.sourceText) continue;
      if (stringSimilarity(self.sourceText, other.sourceText) >= MISSPELLING_THRESHOLD) {
        self.similarTo = other.key;
        break;
      }
    }
  }

  return groups;
}

// --- copying an answer across the misspelling hint -----------------------

/** A `GroupChoice`'s value fields — everything on the answer except the chip itself. */
export type GroupChoiceField = Exclude<keyof GroupChoice, "kind">;

/**
 * The value fields each chip actually carries, in the order the card lays them out.
 *
 * `skip` carries none: the chip *is* the answer. This is the same set `isGroupAnswered` and
 * `choiceToAttribution` read, which is what makes a copy of these fields a copy of the
 * answer rather than a copy of the form.
 */
export const ANSWER_FIELDS_BY_KIND: Record<AttributionKind, readonly GroupChoiceField[]> = {
  publication: ["publicationTitle", "publicationAuthor"],
  person: ["personName"],
  website: ["websiteName", "websiteUrl"],
  skip: [],
};

/**
 * The edits that reproduce one group's answer on another — what the misspelling hint's
 * "Copy from that source" button plays back (§10.2).
 *
 * Returned as *edits* rather than as a `GroupChoice`, deliberately: the caller dispatches
 * them through `set_group_kind` / `set_group_field`, the same two events a chip click and a
 * keystroke send. There is no third way to write a group's answer, so the copy inherits
 * everything those events do — notably that `set_group_kind` with `skip` also flips the
 * group's recipes to `skip`, which a hand-built `GroupChoice` would silently miss.
 *
 * Only the fields the copied kind carries come across. Copying a book answer must not also
 * overwrite the target's own verbatim `personName`/`websiteName` prefills for chips nobody
 * picked — "take that group's answer" is not "become that group".
 *
 * `null` when there is nothing to copy (no chip picked yet). Note this is deliberately
 * weaker than `isGroupAnswered`: whether the source is *complete* is the caller's gate — it
 * is what decides the button is offered at all.
 */
export function copyAnswerEdits(source: GroupChoice | undefined): { kind: AttributionKind; fields: { field: GroupChoiceField; value: string }[] } | null {
  if (!source || source.kind === null) return null;
  return { kind: source.kind, fields: ANSWER_FIELDS_BY_KIND[source.kind].map((field) => ({ field, value: source[field] })) };
}
