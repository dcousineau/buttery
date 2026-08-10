import type { ImportItem, RailGroupId } from "#/lib/recipe-import/machine.ts";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { cn } from "#/lib/utils.ts";
import { LocalImage } from "./LocalImage.tsx";

/**
 * The list + preview pane (plan §10.1) — "Ready to import", "Already yours", "Already public".
 *
 * **341 rows with no virtualization.** `package.json` ships no windowing library and the plan
 * does not add one, so the list leans on CSS containment instead: every row declares
 * `content-visibility: auto` with a `contain-intrinsic-size` matching its real height, and the
 * browser skips layout, paint, and style for the rows outside the viewport while still
 * reserving their space (so the scrollbar is honest and Ctrl-F still finds them). It is a
 * one-line answer to the problem windowing solves, and unlike windowing it does not break
 * tab order or in-page find.
 *
 * The checkbox's meaning changes per group — include, link, or "import a second copy anyway" —
 * so the label is passed in rather than assumed; a checkbox that reads "import" in one group
 * and "link" in another with the same label would be a lie in one of them.
 */

/**
 * Space a not-yet-rendered row reserves. Measured, not guessed: a row is 69px in the shipped
 * type scale, and an intrinsic size shorter than the real one makes the scrollbar lie and the
 * thumb jump as rows come into view. The `auto` keyword lets the browser replace this estimate
 * with each row's last-rendered height once it has seen it, so the guess only ever matters once.
 */
const ROW_HEIGHT = "auto 4.3125rem";

function metaLine(item: ImportItem): string {
  const parts: string[] = [];
  if (item.sourceUrl) {
    try {
      parts.push(new URL(item.sourceUrl).hostname.replace(/^www\./, ""));
    } catch {
      parts.push(item.sourceUrl);
    }
  } else if (item.sourceText) parts.push(item.sourceText);
  else parts.push("no source");
  const n = item.record.ingredients.length;
  if (n) parts.push(`${n} ${n === 1 ? "ingredient" : "ingredients"}`);
  return parts.join(" · ");
}

function existingLine(item: ImportItem): string | null {
  const existing = item.existing;
  if (!existing) return null;
  const when = new Date(existing.addedAt);
  const date = Number.isNaN(when.valueOf()) ? null : when.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return [existing.name, date ? `added ${date}` : null, existing.addedByHandle].filter(Boolean).join(" · ");
}

export function ImportListPane({
  group,
  items,
  activeItem,
  checkboxLabel,
  isChecked,
  onToggle,
  onSelect,
  onSelectAll,
  onSkipAll,
  onOpenEditor,
  onOpenCompare,
  localImageUrl,
  title,
  summary,
  footer,
}: {
  group: RailGroupId;
  items: ImportItem[];
  activeItem: ImportItem | null;
  /** Verb for this group's checkbox: "Import", "Link", "Import a second copy of". */
  checkboxLabel: string;
  isChecked: (item: ImportItem) => boolean;
  onToggle: (item: ImportItem, checked: boolean) => void;
  onSelect: (clientId: string) => void;
  onSelectAll: () => void;
  onSkipAll: () => void;
  onOpenEditor: (clientId: string) => void;
  onOpenCompare: (clientId: string) => void;
  localImageUrl: (path: string | null) => string | null;
  title: string;
  summary: string;
  footer: React.ReactNode;
}) {
  // `min-h-0` at every level of the column chain: without it a flex child's implicit
  // `min-height: auto` lets 341 rows push the pane past the viewport, the whole document
  // scrolls, and the footer's primary button ends up 23,000px down the page.
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r-2 border-border">
        <div className="flex flex-none items-center gap-2.5 border-b-2 border-border px-4 py-2.5">
          <h2 className="m-0 text-[0.9375rem] font-semibold">{title}</h2>
          <div className="ml-auto flex gap-1.5">
            <Button variant="outline" size="xs" onClick={onSelectAll}>
              Select all
            </Button>
            <Button variant="ghost" size="xs" onClick={onSkipAll}>
              Skip all
            </Button>
          </div>
        </div>

        <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
          {items.map((item) => {
            const active = activeItem?.clientId === item.clientId;
            const checkId = `include-${item.clientId}`;
            return (
              <li
                key={item.clientId}
                style={{ contentVisibility: "auto", containIntrinsicSize: ROW_HEIGHT }}
                className={cn("flex items-center gap-2.5 border-b border-border/60 px-4 py-2", active && "bg-accent shadow-[inset_4px_0_0_var(--secondary)]")}
              >
                <Checkbox id={checkId} size="sm" checked={isChecked(item)} onChange={(event) => onToggle(item, event.target.checked)} aria-label={`${checkboxLabel} ${item.record.name}`} />
                <button type="button" onClick={() => onSelect(item.clientId)} aria-current={active ? "true" : undefined} className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <LocalImage url={localImageUrl(item.localImagePath)} alt="" className="h-[34px] w-11 flex-none" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{item.record.name || item.entryName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{metaLine(item)}</span>
                  </span>
                  {item.verdict === "maybe" ? (
                    <Badge variant="destructive" size="xs">
                      maybe a dupe
                    </Badge>
                  ) : null}
                  <span aria-hidden="true" className="flex-none font-bold text-muted-foreground">
                    ›
                  </span>
                </button>
              </li>
            );
          })}
          {items.length === 0 ? <li className="px-4 py-6 text-sm text-muted-foreground">Nothing in this group.</li> : null}
        </ul>

        <div className="flex flex-none items-center gap-3 border-t-2 border-border bg-card px-4 py-2.5">
          <div className="text-[0.8125rem] text-muted-foreground">{summary}</div>
          <div className="ml-auto" />
          {footer}
        </div>
      </div>

      <aside aria-label="Preview" className="flex min-h-0 w-76 flex-none flex-col bg-card">
        <div className="flex-none border-b-2 border-border px-4 py-2.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">Preview</div>
        {activeItem ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-4">
              <LocalImage url={localImageUrl(activeItem.localImagePath)} alt="" className="h-[132px] w-full" />
              <div className="display-title text-lg/[1.2]">{activeItem.record.name || activeItem.entryName}</div>
              <div className="text-[0.8125rem] text-muted-foreground">{metaLine(activeItem)}</div>
              {activeItem.verdict === "maybe" || activeItem.verdict === "in_box" ? (
                <Alert variant="destructive">
                  <AlertTitle>{activeItem.verdict === "in_box" ? "Already in your box" : "Might already be in your box"}</AlertTitle>
                  <AlertDescription>{existingLine(activeItem) ?? "A recipe in your box has the same key."}</AlertDescription>
                </Alert>
              ) : null}
              <div className="flex flex-col gap-1">
                <div className="text-xs font-semibold text-muted-foreground">Ingredients · {activeItem.record.ingredients.length}</div>
                {activeItem.record.ingredients.slice(0, 8).map((line, i) => (
                  <div key={i} className="text-[0.8125rem]/[1.5]">
                    {line}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-none flex-col gap-2 border-t-2 border-border px-4 py-3">
              {/* "Already yours" is a skipped group: there is nothing to edit until the user
                  ticks the row, and the editor's Keep/Skip footer would contradict that. */}
              {group === "in_box" ? null : (
                <Button variant="secondary" className="w-full" onClick={() => onOpenEditor(activeItem.clientId)}>
                  Edit this recipe
                </Button>
              )}
              {activeItem.existing ? (
                <Button variant="outline" className="w-full" onClick={() => onOpenCompare(activeItem.clientId)}>
                  Compare
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="m-0 p-4 text-sm text-muted-foreground">Pick a recipe to see it here.</p>
        )}
      </aside>
    </div>
  );
}
