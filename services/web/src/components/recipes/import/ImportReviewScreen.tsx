import { useState } from "react";
import type { UseImportSession } from "#/lib/recipe-import/useImportSession.ts";
import {
  commitBlockedReason,
  itemsInGroup,
  railCounts,
  RAIL_GROUP_IDS,
  selectedForCommit,
  type ImportItem,
  type ItemAction,
} from "#/lib/recipe-import/machine.ts";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils.ts";
import { CompareDialog } from "./CompareDialog.tsx";
import { DuplicateQueuePane } from "./DuplicateQueuePane.tsx";
import { GROUP_LABELS, GROUP_LABELS_INLINE, nextGroup, recipeCount } from "./groups.ts";
import { ImportListPane } from "./ImportListPane.tsx";
import { RecipeEditorPane } from "./RecipeEditorPane.tsx";
import { SourcesPane } from "./SourcesPane.tsx";
import { useScreenHeading } from "./useScreenHeading.ts";

/**
 * The review screen (plan §10.1): a rail of five groups on the left, one working pane on the
 * right, and a single primary button that always says what happens next.
 *
 * **The rail's counts do not sum to the total, and that is correct** (§10.3): "Need a source"
 * is cross-cutting — a recipe with no link appears there *and* in its verdict group — because
 * attribution and duplication are independent questions about the same recipe. The rail says
 * so in as many words rather than quietly showing arithmetic that does not add up.
 *
 * Each group gets the pane its work needs, not a generic table: sources are answered per
 * *string*, maybe-duplicates one *recipe* at a time, and the three settled groups are lists
 * with a preview. The primary button walks the rail top to bottom and only turns into
 * "Import N recipes" at the bottom, once every source string has an answer.
 */
export function ImportReviewScreen({ session, onCommit }: { session: UseImportSession; onCommit: () => void }) {
  const { state, dispatch, importer, localImageUrl, comparisons } = session;
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [compareId, setCompareId] = useState<string | null>(null);

  const counts = railCounts(state);
  const blocked = commitBlockedReason(state);
  const group = state.activeGroup;
  const groupItems = itemsInGroup(state, group);
  const activeItem = state.activeItemId ? (state.items[state.itemIndex[state.activeItemId]] ?? null) : null;
  const editingItem = state.editingItemId ? (state.items[state.itemIndex[state.editingItemId]] ?? null) : null;
  const compareItem = compareId ? (state.items[state.itemIndex[compareId]] ?? null) : null;

  const importCount = state.items.filter((item) => item.action === "import").length;
  const linkCount = state.items.filter((item) => item.action === "link").length;
  const skipCount = state.items.filter((item) => item.action === "skip").length;

  const next = nextGroup(group);
  const atBottom = next === null;

  // One button, three jobs: unblock the sources, walk down the rail, start the import. The
  // reason a disabled button is disabled is rendered beside it and wired with
  // `aria-describedby`, because a dead control with no explanation is the §10.4 failure the
  // plan calls out by name.
  const primaryDisabled = atBottom ? blocked !== null : group === "sources" && counts.unansweredGroups > 0;
  const primaryLabel = atBottom ? (blocked ? "Sort the sources first" : `Import ${recipeCount(selectedForCommit(state).length)}`) : `Done · next: ${GROUP_LABELS_INLINE[next]}`;
  const primaryReasonId = "import-primary-reason";
  const primaryReason = primaryDisabled ? (blocked ?? `${counts.unansweredGroups} ${counts.unansweredGroups === 1 ? "source needs" : "sources need"} an answer first.`) : null;

  const footer = (
    <>
      {primaryReason ? (
        <span id={primaryReasonId} className="text-[0.8125rem] text-muted-foreground">
          {primaryReason}
        </span>
      ) : null}
      <Button variant="secondary" disabled={primaryDisabled} aria-describedby={primaryReason ? primaryReasonId : undefined} onClick={() => (atBottom ? onCommit() : dispatch({ type: "select_group", group: next }))}>
        {primaryLabel}
      </Button>
    </>
  );

  /** What this group's checkbox means. `in_box` is an override, not an inclusion (§6.3, D23). */
  function isChecked(item: ImportItem): boolean {
    if (group === "in_box") return item.override;
    if (group === "public") return item.action === "link";
    return item.action === "import";
  }

  function onToggle(item: ImportItem, checked: boolean) {
    if (group === "in_box") dispatch({ type: "set_override", clientId: item.clientId, override: checked });
    else dispatch({ type: "set_action", clientId: item.clientId, action: checked ? (group === "public" ? "link" : "import") : "skip" });
  }

  function bulk(checked: boolean) {
    if (group === "in_box") {
      for (const item of groupItems) dispatch({ type: "set_override", clientId: item.clientId, override: checked });
      return;
    }
    dispatch({ type: "set_group_actions", group, action: checked ? (group === "public" ? "link" : "import") : "skip" });
  }

  /** Move to the next row in this group, or fall out of the group when there is none. */
  function advance(from: string) {
    const i = groupItems.findIndex((item) => item.clientId === from);
    const following = groupItems[i + 1];
    if (following) dispatch({ type: "select_item", clientId: following.clientId });
    else if (next) dispatch({ type: "select_group", group: next });
  }

  // The queue always has a card while the group has rows: landing on `maybe` from the rail
  // with nothing selected must not fall through to the list pane, which would label a stack of
  // undecided near-duplicates with another group's copy and offer a "Select all" for them.
  const queueItem = group === "maybe" ? (activeItem ?? groupItems[0] ?? null) : null;

  const listTitle =
    group === "ready"
      ? `Ready to import · ${groupItems.length}`
      : group === "in_box"
        ? `Already in your box · ${groupItems.length} · skipped`
        : group === "maybe"
          ? `Maybe duplicates · ${groupItems.length}`
          : `Already public · ${groupItems.length} · will be linked`;
  const listSummary =
    group === "ready"
      ? `${importCount} to import · ${linkCount} to link · ${skipCount} skipped`
      : group === "in_box"
        ? "Nothing here will be imported — tick one to bring in a second copy"
        : group === "maybe"
          ? "Nothing here is ambiguous — every recipe's keys were clear enough to decide without you"
          : "These already exist publicly — Buttery adds the existing record to your box";

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Review groups" className="flex w-56 flex-none flex-col border-r-2 border-border bg-card">
        <div className="border-b-2 border-border px-3.5 pt-3.5 pb-2.5">
          <h1 ref={heading} tabIndex={-1} className="display-title m-0 text-[1.0625rem]/[1.15] outline-none">
            {recipeCount(state.items.length)}
          </h1>
          <div className="mt-0.5 text-xs text-muted-foreground">{state.fileName ? `from the ${state.fileName} folder` : "ready to review"}</div>
        </div>

        <ul className="m-0 flex flex-1 list-none flex-col gap-1.5 overflow-auto p-2.5">
          {RAIL_GROUP_IDS.map((id) => {
            const active = id === group;
            const count = counts[id];
            const danger = id === "sources" && counts.unansweredGroups > 0;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "select_group", group: id })}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-[0.6rem] border-2 border-border px-2.5 py-2 text-left text-[0.8125rem] transition-all focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    active ? "bg-secondary font-semibold text-secondary-foreground shadow-pop-sm" : "bg-background hover:bg-accent",
                    !active && danger && "border-destructive text-destructive",
                  )}
                >
                  <span className="min-w-0 flex-1">{GROUP_LABELS[id]}</span>
                  <span className="font-bold">{count}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border/60 px-3.5 py-3 text-xs/[1.5] text-muted-foreground">
          Work top to bottom. Recipes that need a source can't be saved until you've sorted them. A recipe can appear in two groups, so these don't add up to{" "}
          {state.items.length}.
        </div>

        {state.failures.length > 0 || state.collapsedInBatch > 0 ? (
          <div className="border-t border-border/60 px-3.5 py-3 text-xs/[1.5] text-muted-foreground">
            {state.failures.length > 0 ? (
              <div>
                <Badge variant="destructive" size="xs">
                  {state.failures.length} couldn't be read
                </Badge>
              </div>
            ) : null}
            {state.collapsedInBatch > 0 ? <div className="mt-1.5">{state.collapsedInBatch} were duplicates of each other in this folder.</div> : null}
          </div>
        ) : null}
      </nav>

      {/* The counts change as the user works, so they are announced — once per change, not per
          keystroke, because the string only differs when a number does (§10.4). */}
      <p className="sr-only" aria-live="polite">
        {`${importCount} to import, ${linkCount} to link, ${skipCount} skipped, ${counts.unansweredGroups} sources still to answer.`}
      </p>

      {editingItem ? (
        <RecipeEditorPane
          item={editingItem}
          importerLabel={importer.label}
          position={groupItems.findIndex((item) => item.clientId === editingItem.clientId) + 1}
          total={groupItems.length}
          localImageUrl={localImageUrl}
          onPatch={(patch) => dispatch({ type: "edit_record", clientId: editingItem.clientId, patch })}
          onClose={() => dispatch({ type: "close_editor" })}
          onSkip={() => {
            dispatch({ type: "set_action", clientId: editingItem.clientId, action: "skip" });
            dispatch({ type: "close_editor" });
          }}
          onKeepNext={() => {
            dispatch({ type: "set_action", clientId: editingItem.clientId, action: group === "public" ? "link" : "import" });
            const i = groupItems.findIndex((item) => item.clientId === editingItem.clientId);
            const following = groupItems[i + 1];
            if (following) dispatch({ type: "open_editor", clientId: following.clientId });
            else dispatch({ type: "close_editor" });
          }}
          onOpenCompare={() => setCompareId(editingItem.clientId)}
        />
      ) : group === "sources" ? (
        <SourcesPane
          groups={state.groups}
          choices={state.groupChoices}
          onKind={(groupKey, kind) => dispatch({ type: "set_group_kind", groupKey, kind })}
          onField={(groupKey, field, value) => dispatch({ type: "set_group_field", groupKey, field, value })}
          footer={footer}
        />
      ) : queueItem ? (
        <DuplicateQueuePane
          // One card per recipe: the remount is what resets the card's own "show matching
          // lines" toggle without an effect that fires after the next card has painted.
          key={queueItem.clientId}
          item={queueItem}
          position={groupItems.findIndex((item) => item.clientId === queueItem.clientId) + 1}
          total={groupItems.length}
          isLast={groupItems[groupItems.length - 1]?.clientId === queueItem.clientId}
          importerLabel={importer.label}
          comparisons={comparisons}
          nextName={groupItems[groupItems.findIndex((item) => item.clientId === queueItem.clientId) + 1]?.record.name ?? null}
          onDecide={(action: ItemAction) => {
            dispatch({ type: "set_action", clientId: queueItem.clientId, action });
            advance(queueItem.clientId);
          }}
        />
      ) : (
        <ImportListPane
          group={group}
          items={groupItems}
          activeItem={activeItem}
          checkboxLabel={group === "in_box" ? "Import a second copy of" : group === "public" ? "Link" : "Import"}
          isChecked={isChecked}
          onToggle={onToggle}
          onSelect={(clientId) => dispatch({ type: "select_item", clientId })}
          onSelectAll={() => bulk(true)}
          onSkipAll={() => bulk(false)}
          onOpenEditor={(clientId) => dispatch({ type: "open_editor", clientId })}
          onOpenCompare={setCompareId}
          localImageUrl={localImageUrl}
          title={listTitle}
          summary={listSummary}
          footer={footer}
        />
      )}

      <CompareDialog
        item={compareItem}
        importerLabel={importer.label}
        comparisons={comparisons}
        onSkip={() => {
          if (compareItem) dispatch({ type: "set_action", clientId: compareItem.clientId, action: "skip" });
          setCompareId(null);
        }}
        onImportAnyway={() => {
          if (compareItem) {
            // An `in_box` match needs the explicit override to survive the server's re-check
            // (§6.3, D23); anything else is a plain import.
            if (compareItem.verdict === "in_box") dispatch({ type: "set_override", clientId: compareItem.clientId, override: true });
            else dispatch({ type: "set_action", clientId: compareItem.clientId, action: "import" });
          }
          setCompareId(null);
        }}
        onClose={() => setCompareId(null)}
      />
    </div>
  );
}
