import { EyeOff } from "lucide-react";
import { Dialog, DialogContent } from "#/components/ui/dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { RecipeView, type RecipeViewData } from "../RecipeView";

/**
 * The create form's Preview (plan §A5/§A6): the recipe detail rendered full-width
 * from the current unsaved form state via the same `RecipeView` used on the real
 * detail page. Read-only — no actions, nothing is saved.
 */
export function PreviewDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data: RecipeViewData }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="p-0">
        <div className="flex items-center gap-2 border-b-2 border-border px-3.5 py-2">
          <span className="text-sm font-bold">Preview</span>
          <Badge variant="outline" size="xs">
            <EyeOff className="size-3" aria-hidden="true" />
            Private
          </Badge>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>
            Back to editing
          </Button>
        </div>
        <div className="max-h-[min(80vh,900px)] overflow-auto p-5">
          <RecipeView data={data} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
