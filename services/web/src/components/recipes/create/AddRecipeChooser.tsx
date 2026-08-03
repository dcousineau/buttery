import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenText, Link2, PencilLine, Puzzle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";

type Choice = "import" | "manual" | "bookmarklet";

/**
 * The single "Add a recipe" entry point (plan §A4). Offers the three create paths
 * plus a demoted "Add an existing recipe" branch that opens the GlobalRecipePicker.
 * The create paths navigate to the full-page form (`/household/recipes/new`);
 * "Import from a URL" carries the source URL so the form locks Website attribution
 * to it. Server-side scrape + bookmarklet are Phase B/C — the bookmarklet option
 * is shown but disabled here.
 */
export function AddRecipeChooser({ open, onOpenChange, onAddExisting }: { open: boolean; onOpenChange: (o: boolean) => void; onAddExisting: () => void }) {
  const navigate = useNavigate();
  const [choice, setChoice] = useState<Choice>("manual");
  const [url, setUrl] = useState("");

  function goManual() {
    onOpenChange(false);
    navigate({ to: "/household/recipes/new" });
  }

  function goImport() {
    const trimmed = url.trim();
    if (!trimmed) return;
    onOpenChange(false);
    navigate({ to: "/household/recipes/new", search: { source: trimmed } });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogTitle>Add a recipe</DialogTitle>
        <DialogDescription>Bring one in from the web, or write it out yourself.</DialogDescription>

        <div className="mt-2 flex flex-col gap-2">
          <Option
            selected={choice === "import"}
            onSelect={() => setChoice("import")}
            icon={<Link2 className="size-4" aria-hidden="true" />}
            title="Import from a URL"
            description="Paste a recipe link and Buttery reads the page."
          >
            {choice === "import" && (
              <div className="mt-2 flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && goImport()}
                  placeholder="https://smittenkitchen.com/…"
                  aria-label="Recipe URL"
                />
                <Button onClick={goImport} disabled={!url.trim()}>
                  Fetch
                </Button>
              </div>
            )}
          </Option>

          <Option
            selected={choice === "manual"}
            onSelect={() => setChoice("manual")}
            icon={<PencilLine className="size-4" aria-hidden="true" />}
            title="Enter it manually"
            description="The empty form. You pick the attribution."
          >
            {choice === "manual" && (
              <div className="mt-2">
                <Button onClick={goManual}>
                  <BookOpenText data-icon="inline-start" aria-hidden="true" />
                  Start a blank recipe
                </Button>
              </div>
            )}
          </Option>

          <Option
            selected={choice === "bookmarklet"}
            onSelect={() => setChoice("bookmarklet")}
            icon={<Puzzle className="size-4" aria-hidden="true" />}
            title="Use the bookmarklet"
            description="For sites that won't let Buttery read them."
            soon
          />
        </div>

        <DialogFooter className="mt-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onAddExisting();
            }}
          >
            Add an existing recipe
          </Button>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  selected,
  onSelect,
  icon,
  title,
  description,
  soon,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  soon?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border-2 border-border bg-card p-3 transition-colors", selected && !soon && "bg-accent shadow-(--shadow-pop-sm)", soon && "opacity-60")}>
      <button type="button" disabled={soon} aria-pressed={selected} onClick={onSelect} className="flex w-full items-start gap-3 text-left outline-none disabled:cursor-not-allowed">
        <span className="mt-0.5 grid size-8 shrink-0 place-content-center rounded-md border-2 border-border bg-background text-foreground">{icon}</span>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-[0.9375rem] font-bold text-foreground">
            {title}
            {soon && <span className="rounded-4xl border-2 border-border px-1.5 text-[0.6rem] font-semibold tracking-wide uppercase text-muted-foreground">soon</span>}
          </span>
          <span className="text-[0.8125rem] text-muted-foreground">{description}</span>
        </span>
      </button>
      {children}
    </div>
  );
}
