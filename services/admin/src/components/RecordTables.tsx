import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";
import { flattenRecord, type ComparisonRow } from "#/lib/record-shape";

/**
 * The three ways the detail view renders data. All three are tables, on purpose
 * — the point of this page is to read a schema, and prose or a pretty recipe
 * card is exactly what an operator does not want here.
 *
 * - `RawRecordTable`     — any JSON value as `path / type / value`.
 * - `RowTable`           — one database row as `column / value`.
 * - `ComparisonTable`    — the local copy and the network record, path by path.
 */

/** Render a stored value for a table cell without hiding its shape. */
export function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length === 0 ? "[]" : JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return `<${typeof value}>`;
}

/**
 * A JSON value as a flat `path → type → value` table.
 *
 * This is the "raw schema" view: every path present on the wire shows up,
 * including ones no lexicon we ship declares. Container rows (objects, arrays)
 * are kept rather than collapsed — a `{0}` beside `embed` says the field is
 * present and empty, which is a different fact from the field being absent.
 */
export function RawRecordTable({ value, emptyMessage = "No record." }: { value: unknown; emptyMessage?: string }) {
  const rows = flattenRecord(value);
  if (value === null || value === undefined || rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>;
  }
  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[38%]">Path</TableHead>
            <TableHead className="w-[10%]">Type</TableHead>
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.path}>
              <TableCell className="font-mono text-xs align-top">
                {/* Indent by depth so nesting is legible without re-reading the
                    dotted path on every row. `padding-inline-start` (not a
                    margin) keeps the cell's own hit area intact. */}
                <span style={{ paddingInlineStart: `${row.depth * 0.75}rem` }}>{row.path}</span>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground align-top">{row.type}</TableCell>
              <TableCell className={cn("text-xs align-top", row.container ? "text-muted-foreground font-mono" : "whitespace-pre-wrap [overflow-wrap:anywhere]")}>
                {row.value}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One database row as a `column → value` table, columns in alphabetical order. */
export function RowTable({ row, emptyMessage = "No row." }: { row: Record<string, unknown> | null | undefined; emptyMessage?: string }) {
  if (!row) return <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>;
  const entries = Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">Column</TableHead>
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([key, value]) => (
            <TableRow key={key}>
              <TableCell className="font-mono text-xs align-top">{key}</TableCell>
              <TableCell className="text-xs align-top whitespace-pre-wrap [overflow-wrap:anywhere]">{renderCell(value)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const STATUS_LABEL: Record<ComparisonRow["status"], string> = {
  same: "same",
  differs: "differs",
  "local-only": "local only",
  "network-only": "network only",
  absent: "not set",
};

/**
 * Local and network, side by side, one row per field path.
 *
 * **Nothing here picks a winner.** The app's read path resolves a recipe from
 * whichever source it trusts, and that resolution is precisely what hides a
 * local copy that has drifted from what the user actually published. This table
 * shows both columns and labels the relationship; deciding what to do about a
 * `differs` row is a human's job.
 */
export function ComparisonTable({ rows, showOnlyDifferences }: { rows: ComparisonRow[]; showOnlyDifferences?: boolean }) {
  // "Only differences" hides `absent` alongside `same`: a field neither copy
  // sets is not a disagreement, and leaving those rows in is what made the
  // filter useless on a sparsely-populated recipe.
  const visible = showOnlyDifferences ? rows.filter((row) => row.status !== "same" && row.status !== "absent") : rows;

  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{showOnlyDifferences ? "The two copies agree on every field." : "Nothing to compare."}</p>;
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[22%]">Field</TableHead>
            <TableHead className="w-[32%]">Local (Postgres)</TableHead>
            <TableHead className="w-[32%]">ATProto record</TableHead>
            <TableHead className="w-[14%]">State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.path} className={cn(row.status === "differs" && "bg-destructive/5")}>
              <TableCell className="align-top">
                <span className="text-xs font-medium">{row.label}</span>
                {row.label !== row.path ? <span className="block font-mono text-[11px] text-muted-foreground">{row.path}</span> : null}
              </TableCell>
              <TableCell className="text-xs align-top whitespace-pre-wrap [overflow-wrap:anywhere]">{row.local ?? <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell className="text-xs align-top whitespace-pre-wrap [overflow-wrap:anywhere]">{row.network ?? <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell className="align-top">
                <Badge
                  variant={row.status === "same" ? "secondary" : row.status === "differs" ? "destructive" : "outline"}
                  className={row.status === "absent" ? "text-muted-foreground" : undefined}
                >
                  {STATUS_LABEL[row.status]}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
