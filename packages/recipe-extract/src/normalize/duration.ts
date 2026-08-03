/**
 * Duration normalization → ISO-8601 (`PT#H#M`), the shape the lexicon stores.
 * schema.org usually emits ISO already; some sites emit human strings
 * ("1 hr 30 mins", "45 minutes", "1.5 hours"). Best-effort, hours + minutes
 * only (recipe times rarely need seconds). Returns undefined when nothing
 * usable parses out. Pure — no deps.
 */

/** Build `PT#H#M` from a total minute count (0 → undefined). */
function isoFromMinutes(totalMin: number): string | undefined {
  const mins = Math.round(totalMin);
  if (!Number.isFinite(mins) || mins <= 0) return undefined;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  // mins > 0 here, so at least one of H/M is present → always a valid duration.
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

/** Parse an ISO-8601 duration's hour/minute (and day → hours) parts to minutes. */
function minutesFromIso(v: string): number | undefined {
  // PnDTnHnMnS — we care about D/H/M. Reject if it doesn't look like a duration.
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i.exec(v.trim());
  if (!m) return undefined;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const total = days * 24 * 60 + hours * 60 + mins;
  return total > 0 ? total : undefined;
}

/** Parse a human string like "1 hour 30 min" / "45 minutes" / "1.5 hrs" to minutes. */
function minutesFromHuman(v: string): number | undefined {
  const s = v.toLowerCase();
  let total = 0;
  let matched = false;
  const hourRe = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/g;
  const minRe = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/g;
  let mm: RegExpExecArray | null;
  while ((mm = hourRe.exec(s))) {
    total += parseFloat(mm[1]) * 60;
    matched = true;
  }
  while ((mm = minRe.exec(s))) {
    total += parseFloat(mm[1]);
    matched = true;
  }
  return matched && total > 0 ? total : undefined;
}

/** Normalize any supported duration form to ISO-8601, or undefined. */
export function toIsoDuration(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // A bare number is ambiguous; schema.org sometimes gives minutes as a number.
    return isoFromMinutes(v);
  }
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (/^P/i.test(s)) {
    const mins = minutesFromIso(s);
    return mins ? isoFromMinutes(mins) : undefined;
  }
  const mins = minutesFromHuman(s);
  return mins ? isoFromMinutes(mins) : undefined;
}
