import { useLayoutEffect, useRef } from "react";
import type { ImportItem, RailGroupId } from "#/lib/recipe-import/machine.ts";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { RecipeSlat, RecipeSlatAction, RecipeSlatAside, RecipeSlatBody, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle } from "#/components/recipes/RecipeSlat";
import { LocalImage } from "./LocalImage.tsx";
import { useWindowedRows } from "./useWindowedRows.ts";

/**
 * The list + preview pane (plan §10.1) — "Ready to import", "Already yours", "Already public".
 *
 * **341 rows, windowed** (§9, §10.3, §16.16). Only the rows inside the scrollport plus an
 * overscan are mounted; two spacer `<li>`s stand in for the rest, so the scrollbar is honest
 * and the pane holds ~25 elements instead of 341. The rows are uniform by construction — one
 * truncated title, one truncated meta line, a fixed thumbnail — which is what makes a
 * fixed-height window correct here; `useWindowedRows` measures the real height rather than
 * trusting a constant. The earlier `content-visibility: auto` answer is gone: it skipped paint
 * for offscreen rows but still reconciled all 341 and still minted an object URL per
 * thumbnail, which is what forced the image cache's bound to 1024.
 *
 * The cost windowing has to buy back is keyboard reach — Tab cannot visit a row that is not in
 * the DOM. So the rows carry real arrow-key navigation (↑/↓, Home/End, PageUp/PageDown): the
 * target row is scrolled into the window, selected, and focused, which also makes 341 rows
 * navigable without 341 Tab presses. In-page find no longer reaches unmounted rows; nothing in
 * this flow depends on Ctrl-F, and a 341-row Tab loop was never a usable substitute either.
 *
 * The checkbox's meaning changes per group — include, link, or "import a second copy anyway" —
 * so the label is passed in rather than assumed; a checkbox that reads "import" in one group
 * and "link" in another with the same label would be a lie in one of them.
 */

/** Stable id per row, so a row scrolled into view can be focused once React has mounted it. */
function rowButtonId(clientId: string): string {
  return `import-row-${clientId}`;
}

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
  batchDuplicateName,
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
  /** Name of the earlier entry in this same drop a `dupe_in_batch` row duplicates. */
  batchDuplicateName: (item: ImportItem) => string | null;
  title: string;
  summary: string;
  footer: React.ReactNode;
}) {
  const { scrollRef, onScroll, measureRow, start, end, topPad, bottomPad, scrollRowIntoView, rowHeight } = useWindowedRows({ count: items.length, resetKey: group });
  const visible = items.slice(start, end);

  // Focus cannot be moved to a row that has not been rendered yet, so the keyboard handler
  // records the row it wants and this effect focuses it in the commit that mounts it.
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const clientId = pendingFocus.current;
    if (!clientId) return;
    pendingFocus.current = null;
    document.getElementById(rowButtonId(clientId))?.focus();
  });

  function moveTo(index: number) {
    const item = items[index];
    if (!item) return;
    pendingFocus.current = item.clientId;
    // Scroll first: `scrollRowIntoView` updates the window synchronously, so the render that
    // follows this handler already contains the row the effect above is about to focus.
    scrollRowIntoView(index);
    onSelect(item.clientId);
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLElement>, index: number) {
    const last = items.length - 1;
    if (last < 0) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowHeight) - 1);
    let target: number;
    switch (event.key) {
      case "ArrowDown":
        target = Math.min(index + 1, last);
        break;
      case "ArrowUp":
        target = Math.max(index - 1, 0);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      case "PageDown":
        target = Math.min(index + page, last);
        break;
      case "PageUp":
        target = Math.max(index - page, 0);
        break;
      default:
        return;
    }
    // Claimed even when the target is the current row: at the ends of the list the arrow keys
    // belong to the list, and letting them scroll the pane under a stationary focus ring is
    // the confusing half of the behaviour.
    event.preventDefault();
    if (target !== index) moveTo(target);
  }

  const activeAlert = activeItem
    ? activeItem.verdict === "dupe_in_batch"
      ? {
          title: "Already in this folder",
          body: `${batchDuplicateName(activeItem) ?? "An earlier recipe in this folder"} has the same key — only the first copy is imported. Tick this row to bring in a second copy anyway.`,
        }
      : activeItem.verdict === "in_box"
        ? { title: "Already in your box", body: existingLine(activeItem) ?? "A recipe in your box has the same key." }
        : activeItem.verdict === "maybe"
          ? { title: "Might already be in your box", body: existingLine(activeItem) ?? "A recipe in your box has the same key." }
          : null
    : null;

  // `min-h-0` at every level of the column chain: without it a flex child's implicit
  // `min-height: auto` lets the rows push the pane past the viewport, the whole document
  // scrolls, and the footer's primary button ends up far down the page.
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

        {/* Said once, not per row: the list is windowed, so the arrow keys are how a keyboard
            reaches a row that is not currently in the DOM (§10.4). */}
        <p className="sr-only">Use the up and down arrow keys to move through this list. Home and End jump to the first and last recipe.</p>

        <RecipeSlatList ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
          {topPad > 0 ? <li aria-hidden="true" style={{ height: topPad }} /> : null}
          {visible.map((item, offset) => {
            const index = start + offset;
            const active = activeItem?.clientId === item.clientId;
            const checkId = `include-${item.clientId}`;
            return (
              <RecipeSlat
                key={item.clientId}
                // Every row is the same height; the first one measured is what the window's
                // arithmetic runs on from then on. The slat keeps that true — its lines all
                // truncate, and the container-query tiers are a property of the pane's width,
                // so they switch for every row at once or for none.
                ref={offset === 0 ? measureRow : undefined}
                selected={active}
              >
                <Checkbox
                  id={checkId}
                  size="sm"
                  checked={isChecked(item)}
                  onChange={(event) => onToggle(item, event.target.checked)}
                  aria-label={`${checkboxLabel} ${item.record.name}`}
                />
                <RecipeSlatAction
                  type="button"
                  id={rowButtonId(item.clientId)}
                  onClick={() => onSelect(item.clientId)}
                  onKeyDown={(event) => onRowKeyDown(event, index)}
                  aria-current={active ? "true" : undefined}
                >
                  <LocalImage url={localImageUrl(item.localImagePath)} alt="" className="h-[34px] w-11 flex-none" />
                  <RecipeSlatBody>
                    <RecipeSlatTitle>
                      <span className="truncate">{item.record.name || item.entryName}</span>
                    </RecipeSlatTitle>
                    <RecipeSlatMeta>{metaLine(item)}</RecipeSlatMeta>
                  </RecipeSlatBody>
                  <RecipeSlatAside>
                    {item.verdict === "maybe" ? (
                      <Badge variant="destructive" size="xs">
                        maybe a dupe
                      </Badge>
                    ) : null}
                    <span aria-hidden="true" className="font-bold">
                      ›
                    </span>
                  </RecipeSlatAside>
                </RecipeSlatAction>
              </RecipeSlat>
            );
          })}
          {bottomPad > 0 ? <li aria-hidden="true" style={{ height: bottomPad }} /> : null}
          {items.length === 0 ? <li className="px-4 py-6 text-sm text-muted-foreground">Nothing in this group.</li> : null}
        </RecipeSlatList>

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
              {activeAlert ? (
                <Alert variant="destructive">
                  <AlertTitle>{activeAlert.title}</AlertTitle>
                  <AlertDescription>{activeAlert.body}</AlertDescription>
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
