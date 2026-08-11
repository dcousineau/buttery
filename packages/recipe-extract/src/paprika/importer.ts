import { directoryEntrySource } from "../import/entry-source.ts";
import type { ImporterDropCopy, RecipeImporter } from "../import/types.ts";
import { walkPaprikaExport } from "./export.ts";
import { parsePaprikaRecipe } from "./recipe.ts";

/**
 * The launch screen's copy, verbatim from the design comp's drop state
 * (`Paprika Import.dc.html`, §10). It lives on the importer rather than in the route
 * because every line of it is a fact about Paprika's export — "Paprika writes a folder, not
 * a single file" is D19 stated as user-facing copy — while the *fields* are what any
 * importer's launch point needs (§9). That split is what lets the route render this without
 * naming an importer, which is the §2.5 boundary the ESLint rule enforces.
 *
 * Deviation from the comp, deliberate: the comp bolds fragments inside the steps
 * (`File → Export…`, `All Recipes`, `HTML`). These are plain strings, so that emphasis is
 * lost — carrying `<strong>` here would force the route to dangerously-set importer-supplied
 * markup, which is a bad trade for three bold words. The wording is unchanged.
 */
export const PAPRIKA_DROP_COPY: ImporterDropCopy = {
  title: "Import from Paprika",
  lede: "Bring your whole Paprika 3 recipe box into {household}. The folder is read here in your browser — nothing is uploaded until you've looked it over.",
  heading: "Drop your exported recipe folder here",
  body: "The whole folder Paprika made — index.html, Recipes, Images and all",
  cta: "Choose a folder",
  help: {
    title: "Getting your recipes out of Paprika",
    steps: [
      "In Paprika on your computer, choose File → Export….",
      "Leave Categories on All Recipes, set Format to HTML, and pick where to save.",
      "Paprika writes a folder, not a single file — drop that folder above.",
    ],
    links: [
      { label: "exporting on Mac", href: "https://www.paprikaapp.com/help/mac/#exportrecipes" },
      { label: "exporting on Windows", href: "https://www.paprikaapp.com/help/windows/#exportrecipes" },
    ],
  },
};

/**
 * The one importer phase 1 ships (§2.5).
 *
 * Thin by design: everything it does is delegated to a module that is testable on its own,
 * and the object exists so exactly one place in the web app — the registry — has to know
 * the string `paprika`. A second importer is a sibling of this file and touches nothing
 * else.
 */
export const paprikaImporter: RecipeImporter = {
  id: "paprika",
  label: "Paprika 3",
  dropCopy: PAPRIKA_DROP_COPY,
  // Phase 1 has exactly one acquisition shape: a dropped or picked directory. An
  // archive-backed source would be a different `EntrySource` here and would change nothing
  // below it (§4.2, §17).
  // Deferred, not `Promise.resolve(...)`: `directoryEntrySource` throws for an
  // oversized drop, and `open` is contracted to reject rather than throw sync.
  open: (input) => Promise.resolve().then(() => directoryEntrySource(input.files)),
  entries: (source) => walkPaprikaExport(source),
  parse: (entry) => parsePaprikaRecipe(entry.html, entry),
};
