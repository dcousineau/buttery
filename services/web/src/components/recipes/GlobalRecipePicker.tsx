import { useCallback, useEffect, useRef, useState } from "react";
import { Search, UtensilsCrossed } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "#/components/ui/dialog";
import { Spinner } from "#/components/ui/spinner";
import { addRecipeToHousehold, type GlobalRecipeResult, searchGlobalRecipes } from "#/server/household-recipes";
import { cn } from "#/lib/utils";
import { SourceIcon } from "./SourceIcon";

/**
 * The global recipe picker (plan §5.5) — the "Add" affordance. Searches the
 * PUBLIC rendered collection (server-side; the corpus is large), excluding
 * recipes already in the household's box, and links a selection into the box via
 * `addRecipeToHousehold`. This only LINKS existing public recipes; it is not
 * recipe creation.
 */
export function GlobalRecipePicker({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: (recipeId: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GlobalRecipeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const reqId = useRef(0);

  const runSearch = useCallback(async (query: string) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const { results } = await searchGlobalRecipes({ data: { q: query, limit: 25 } });
      if (id === reqId.current) setResults(results);
    } catch {
      if (id === reqId.current) setResults([]);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // Load recent-public on open; debounce subsequent typing.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void runSearch(q), q ? 220 : 0);
    return () => clearTimeout(t);
  }, [open, q, runSearch]);

  // Reset the query on every close so the next open starts empty — all close
  // paths route through here (Escape/overlay via the Dialog, and `add` below),
  // which avoids resetting state from inside an effect.
  function handleOpenChange(next: boolean) {
    if (!next) setQ("");
    onOpenChange(next);
  }

  async function add(recipeId: string) {
    setAdding(recipeId);
    try {
      await addRecipeToHousehold({ data: { recipeId } });
      onAdded(recipeId);
      handleOpenChange(false);
    } finally {
      setAdding(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="lg" className="max-h-[80vh]">
        <DialogTitle>Add a recipe</DialogTitle>
        <DialogDescription>Search the public collection and add a recipe to your household's box.</DialogDescription>

        <div className="flex h-9 items-center gap-2 rounded-lg border-2 border-border bg-background px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- modal search field; focusing on open is the expected affordance
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search public recipes…"
            aria-label="Search public recipes"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {loading && <Spinner aria-hidden className="size-4 text-muted-foreground" />}
        </div>

        {/* Search feedback for non-sighted users: loading + result count are
         * status messages, announced politely (the spinner is aria-hidden). */}
        <div className="sr-only" role="status" aria-live="polite">
          {loading
            ? "Searching…"
            : results.length === 0
              ? q
                ? "No public recipes match that."
                : "No recipes to add."
              : `${results.length} recipe${results.length === 1 ? "" : "s"} found.`}
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-auto px-1">
          {results.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{q ? "No public recipes match that." : "No recipes to add."}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {results.map((r) => (
                <li key={r.recipeId}>
                  <button
                    type="button"
                    disabled={adding !== null}
                    onClick={() => add(r.recipeId)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border-2 border-transparent p-1.5 text-left transition-colors hover:border-border hover:bg-accent focus-visible:border-border focus-visible:bg-accent focus-visible:outline-none disabled:opacity-60",
                    )}
                  >
                    {r.thumbUrl ? (
                      <img src={r.thumbUrl} alt="" className="size-11 shrink-0 rounded-sm border-2 border-border object-cover" loading="lazy" />
                    ) : (
                      <div className="grid size-11 shrink-0 place-content-center rounded-sm border-2 border-border bg-muted">
                        <UtensilsCrossed className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-bold text-foreground">{r.title}</span>
                      <span className="flex items-center gap-1 truncate text-[0.6875rem] font-semibold text-muted-foreground">
                        <SourceIcon kind={r.source.kind} className="size-[11px] shrink-0" />
                        <span className="truncate">{r.source.label}</span>
                      </span>
                    </div>
                    {adding === r.recipeId && <Spinner aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
