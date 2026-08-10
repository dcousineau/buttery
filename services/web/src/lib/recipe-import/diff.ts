import { normalizeLine } from "@buttery/recipe-schemas/normalize";

/**
 * Client-side line diff for the duplicate queue and the compare overlay (§7.6, D21).
 *
 * The plan is explicit that there is no server-side diff, no match score, and no per-line
 * similarity field: both sides are already in the browser by the time a comparison opens, so
 * the whole comparison is local string work.
 *
 * Lines are matched on `normalizeLine` — the same fold the content fingerprint uses — so
 * "2 Tbsp olive oil" and "2 tbsp. olive oil" read as the same line rather than as a
 * removal beside an addition. The rendered text is always the **verbatim** line.
 */

/**
 * `marker` exists because §10.4 forbids encoding difference by fill colour alone: every row
 * carries a glyph the user can read, in addition to whatever the fill does.
 */
export type DiffStatus = "same" | "added" | "removed";

export interface DiffRow {
  status: DiffStatus;
  /** The verbatim line, from whichever side has it. */
  text: string;
  /** Text/glyph marker rendered beside the line. Never the only difference cue, but never absent. */
  marker: string;
}

const MARKERS: Record<DiffStatus, string> = {
  same: " ", // non-breaking space keeps the gutter's width identical on every row
  added: "+",
  removed: "−", // U+2212 MINUS SIGN — reads as "minus", not as a hyphen in the line's text
};

function row(status: DiffStatus, text: string): DiffRow {
  return { status, text, marker: MARKERS[status] };
}

/**
 * Longest-common-subsequence diff over normalized lines.
 *
 * `left` is the **existing** recipe (what is already in the box or public) and `right` is
 * the incoming candidate, so `added` means "the import has this and your copy does not".
 * O(n·m) in lines; a recipe's ingredient list is tens of lines, and a comparison is opened
 * one at a time by hand, so there is nothing to optimize here.
 */
export function diffLines(left: readonly string[], right: readonly string[]): DiffRow[] {
  const a = left.map(normalizeLine);
  const b = right.map(normalizeLine);

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push(row("same", right[j]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push(row("removed", left[i]));
      i++;
    } else {
      rows.push(row("added", right[j]));
      j++;
    }
  }
  while (i < a.length) rows.push(row("removed", left[i++]));
  while (j < b.length) rows.push(row("added", right[j++]));
  return rows;
}

export interface DiffSummary {
  same: number;
  added: number;
  removed: number;
  /** True when the two sides fold to exactly the same lines in the same order. */
  identical: boolean;
}

export function summarizeDiff(rows: readonly DiffRow[]): DiffSummary {
  const summary: DiffSummary = { same: 0, added: 0, removed: 0, identical: true };
  for (const r of rows) {
    summary[r.status]++;
    if (r.status !== "same") summary.identical = false;
  }
  return summary;
}

/** A one-line, screen-reader-friendly description of a comparison — the live-region text. */
export function describeDiff(summary: DiffSummary, label: string): string {
  if (summary.identical) return `${label}: identical.`;
  const parts: string[] = [];
  if (summary.added) parts.push(`${summary.added} only in the import`);
  if (summary.removed) parts.push(`${summary.removed} only in your copy`);
  if (summary.same) parts.push(`${summary.same} the same`);
  return `${label}: ${parts.join(", ")}.`;
}
