import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, Check, CircleAlert, Clock, Compass, CookingPot, Eye, Link2, ShoppingBasket, UtensilsCrossed, X } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { Select } from "#/components/ui/select";
import { Separator } from "#/components/ui/separator";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "#/components/ui/accordion";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { Spinner } from "#/components/ui/spinner";
import { RECIPE_VOCAB, slugForLabel, slugForToken, tokenForSlug } from "#/lib/recipe-vocab";
import { useHydratedSession } from "#/lib/auth-client";
import { reconnectAtproto } from "#/lib/atproto-reauth";
import { type AttributionState, EMPTY_ATTRIBUTION, attributionComplete, buildAttribution } from "#/lib/recipe-attribution";
import { deriveSource } from "#/lib/recipe-provenance";
import { type FieldIssue, getImportPrefill, keys, type RecipeRecordInput, saveRecipe } from "#/lib/api";
import { stageRemoteImage, uploadRecipeImage } from "#/lib/recipe-image-upload";
import { MAX_IMAGE_BYTES } from "#/lib/recipe-image";
import { useRecipesView } from "../context";
import type { RecipeViewData } from "../RecipeView";
import { type EditorMode } from "./LineEditor";
import { IngredientsEditor } from "./IngredientsEditor";
import { InstructionsEditor } from "./InstructionsEditor";
import { AttributionCard } from "./AttributionCard";
import { PreviewDialog } from "./PreviewDialog";
import { DuplicateDialog } from "./DuplicateDialog";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
function minutesToIso(min: string): string | undefined {
  const n = Number.parseInt(min, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}
/** ISO-8601 duration → whole-minute string for the number field (import prefill). */
function isoToMinutes(iso: string | undefined): string {
  if (!iso) return "";
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i.exec(iso.trim());
  if (!m) return "";
  const mins = Number(m[1] ?? 0) * 24 * 60 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return mins > 0 ? String(mins) : "";
}

/**
 * The form's photo: what to show, and what the save will point at.
 *
 * `uploadId` null means "showing something, owning nothing" — the optimistic
 * render of an imported hero's origin URL while the browser tries to fetch and
 * upload it for itself. A save carries the id or it carries no image; the
 * preview URL is never persisted and never reaches the server.
 *
 * `sourceUrl` is set only for an imported hero, and only travels once the bytes
 * are ours. It is logged beside them and never read back — the recipe's image is
 * the object, always.
 */
type FormImage = { previewUrl: string; uploadId: string | null; alt: string; sourceUrl?: string };

/**
 * The full-page recipe create/import form (plan §A5). Plain controlled state
 * (matching the repo's CreateInviteForm pattern); saving/publishing goes through
 * the `saveRecipe` server fn, which re-validates via the lexicon. Save is gated on
 * attribution being complete. Import mode locks Website attribution to the URL.
 */
export function RecipeForm({ householdName, sourceUrl: initialSourceUrl, importId }: { householdName: string; sourceUrl: string | null; importId?: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The cache partition, from the parent layout's `beforeLoad` context — the
  // same value `/household/recipes` keyed its box query with, so the
  // invalidation below is guaranteed to name the entry the ledger is observing.
  const { householdId } = useRouteContext({ from: "/household/recipes" });
  const { posthog } = useAnalytics();
  const { pushToast } = useRecipesView();
  // `handle` is an atproto-plugin column, absent from better-auth's base user type.
  const { data: session } = useHydratedSession() as { data: { user?: { handle?: string | null } } | null };

  // `sourceUrl` null → manual; set → imported (attribution locked). "Start over by
  // hand" drops the lock by clearing this.
  const [sourceUrl, setSourceUrl] = useState<string | null>(initialSourceUrl);
  const imported = sourceUrl != null;

  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [ingredients, setIngredients] = useState<string[]>([""]);
  const [instructions, setInstructions] = useState<string[]>([""]);
  const [ingMode, setIngMode] = useState<EditorMode>(imported ? "rows" : "paste");
  const [insMode, setInsMode] = useState<EditorMode>(imported ? "rows" : "paste");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [prep, setPrep] = useState("");
  const [cook, setCook] = useState("");
  const [recipeYield, setRecipeYield] = useState("");
  const [cuisine, setCuisine] = useState("");
  const [category, setCategory] = useState("");
  const [method, setMethod] = useState("");
  const [diet, setDiet] = useState("");
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [fat, setFat] = useState("");
  const [carbs, setCarbs] = useState("");
  const [attr, setAttr] = useState<AttributionState>({ ...EMPTY_ATTRIBUTION });
  const [image, setImage] = useState<FormImage | null>(null);
  const imageSrc = image?.previewUrl ?? null;

  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [pending, setPending] = useState<null | "draft" | "publish">(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  // The draft saved but the PDS refused the write: this account's atproto grant
  // predates the scopes publishing needs, so it has to be re-authorized.
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthPending, setReauthPending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const attrDone = imported || attributionComplete(attr);
  const saveDisabled = !attrDone || pending != null;
  const importHost = imported && sourceUrl ? hostOf(sourceUrl) : null;

  // Import prefill (plan §B/§C): the recipe is cached server-side and fetched by
  // opaque id (`?import=<id>`) — never carried in the URL. Both Phase B (server
  // scrape) and Phase C (bookmarklet POST) converge here. Fetch once on mount,
  // fill the form, lock attribution to the source. Runs client-side only.
  useEffect(() => {
    if (!importId) return;
    let cancelled = false;
    void (async () => {
      const payload = await getImportPrefill(importId).catch(() => null);
      if (cancelled || !payload) return;
      const r = payload.recipe;
      setSourceUrl(payload.sourceUrl);
      if (r.name) setName(r.name);
      if (r.text) setText(r.text);
      if (r.ingredients?.length) {
        setIngredients(r.ingredients);
        setIngMode("rows");
      }
      if (r.instructions?.length) {
        setInstructions(r.instructions);
        setInsMode("rows");
      }
      if (r.keywords?.length) setKeywords(r.keywords);
      setPrep(isoToMinutes(r.prepTime));
      setCook(isoToMinutes(r.cookTime));
      if (r.recipeYield) setRecipeYield(r.recipeYield);
      const cSlug = slugForLabel("cuisine", r.vocab?.cuisine);
      if (cSlug) setCuisine(cSlug);
      const catSlug = slugForLabel("category", r.vocab?.category);
      if (catSlug) setCategory(catSlug);
      const mSlug = slugForLabel("cooking_method", r.vocab?.method);
      if (mSlug) setMethod(mSlug);
      const dSlug = r.suitableForDiet?.length ? slugForToken("diet", r.suitableForDiet[0]) : null;
      if (dSlug) setDiet(dSlug);
      if (r.nutrition?.calories != null) setCalories(String(r.nutrition.calories));
      if (r.nutrition?.fatContent) setFat(String(r.nutrition.fatContent));
      if (r.nutrition?.proteinContent) setProtein(String(r.nutrition.proteinContent));
      if (r.nutrition?.carbohydrateContent) setCarbs(String(r.nutrition.carbohydrateContent));
      if (r.imageUrl) {
        const alt = r.name ?? "";
        // Optimistic: render the origin's URL right away so the preview is not
        // blank while we try to become its owner. An `<img src>` is not
        // CORS-gated, so this shows even for the hosts the fetch below fails on
        // — but with no `uploadId` it is a picture on screen and nothing more.
        setImage({ previewUrl: r.imageUrl, uploadId: null, alt });
        // Then take our own copy, straight into our bucket. The tab has the
        // user's referer and is far likelier to be served than our backend was.
        // When it doesn't work (no `Access-Control-Allow-Origin`, the usual
        // reason) the preview above stands and the recipe saves without a photo.
        const uploadId = await stageRemoteImage(r.imageUrl);
        if (cancelled || !uploadId) return;
        setImage({ previewUrl: r.imageUrl, uploadId, alt, sourceUrl: r.imageUrl });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importId]);

  function buildRecord(): RecipeRecordInput {
    const nutrition =
      calories || protein || fat || carbs
        ? {
            calories: calories ? Number.parseInt(calories, 10) : undefined,
            fatContent: fat || undefined,
            proteinContent: protein || undefined,
            carbohydrateContent: carbs || undefined,
          }
        : undefined;
    return {
      name: name.trim(),
      text: text.trim(),
      ingredients: ingredients.filter((l) => l.trim()),
      instructions: instructions.filter((l) => l.trim()),
      keywords: keywords.length ? keywords : undefined,
      prepTime: minutesToIso(prep),
      cookTime: minutesToIso(cook),
      recipeYield: recipeYield.trim() || undefined,
      cookingMethod: tokenForSlug("cooking_method", method) ?? undefined,
      recipeCuisine: tokenForSlug("cuisine", cuisine) ?? undefined,
      recipeCategory: tokenForSlug("category", category) ?? undefined,
      suitableForDiet: diet ? ([tokenForSlug("diet", diet)].filter(Boolean) as RecipeRecordInput["suitableForDiet"]) : undefined,
      nutrition,
      // For imports the server re-derives Website attribution from sourceUrl and
      // ignores anything here; for manual entry send the built union.
      attribution: imported ? undefined : (buildAttribution(attr) as RecipeRecordInput["attribution"]),
    };
  }

  /**
   * The box gained a row, so the box query has to be told.
   *
   * This used to be `router.invalidate()`, which stopped doing anything the day
   * `/household/recipes` moved onto `householdRecipesQuery` (§4.1). Re-running
   * that loader now means re-running `ensureQueryData`, and `ensureQueryData`
   * returns whatever is cached without revalidating — there is no
   * `revalidateIfStale` on it. The layout never unmounts while this form is on
   * screen (the form is its child), so its `useSuspenseQuery` observer stays
   * mounted and never refetches on mount either: **the recipe you just wrote
   * did not appear in the ledger at all** until a reload or a window refocus.
   *
   * Invalidating the key is what the router used to do by proxy, and it is also
   * narrower than what the router used to do — one entry, not every loader in
   * the tree (`household.recipes.tsx`'s `onAdded` takes the same shape).
   */
  async function refreshBox() {
    await queryClient.invalidateQueries({ queryKey: keys.household.recipes(householdId) });
  }

  async function submit(publish: boolean) {
    setPending(publish ? "publish" : "draft");
    setIssues([]);
    try {
      const result = await saveRecipe({
        record: buildRecord(),
        visibility: "draft",
        publish,
        sourceUrl,
        // The bytes are already in our bucket; this is only the id that says
        // which object. A preview with no id saves no photo.
        image: image?.uploadId ? { uploadId: image.uploadId, alt: image.alt, sourceUrl: image.sourceUrl ?? null } : null,
      });
      if (result.status === "invalid") {
        setIssues(result.issues);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (result.status === "duplicate") {
        setDuplicateId(result.existingRecipeId);
        return;
      }
      if (result.status === "publish_disabled") {
        posthog.capture("recipe_created", { published: false, imported, publish_blocked: true });
        pushToast("Publishing is turned off right now — kept private.");
        await refreshBox();
        await navigate({ to: "/household/recipes/$id", params: { id: result.recipeId } });
        return;
      }
      if (result.status === "reauth_required") {
        // The recipe is saved as a draft; only the PDS write was refused. Stay
        // put and offer the re-authorization rather than dumping the user on a
        // draft with no explanation.
        posthog.capture("recipe_created", { published: false, imported, reauth_required: true, missing_scope: result.missingScope });
        setReauthPending(false);
        setNeedsReauth(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
        // The recipe *is* in the box — only the PDS write was refused — so the
        // ledger behind this form is already out of date even though we stay put.
        await refreshBox();
        return;
      }
      posthog.capture("recipe_created", { published: result.published, imported });
      await refreshBox();
      await navigate({ to: "/household/recipes/$id", params: { id: result.recipeId } });
    } catch (err) {
      setIssues([{ path: "", message: String(err instanceof Error ? err.message : err) }]);
    } finally {
      setPending(null);
    }
  }

  async function onReconnect() {
    setReauthPending(true);
    const failure = await reconnectAtproto(session?.user?.handle);
    // Only reached when the redirect didn't happen.
    if (failure) {
      setReauthPending(false);
      setIssues([{ path: "", message: failure }]);
    }
  }

  async function onPickFile(file: File) {
    if (file.size > MAX_IMAGE_BYTES) {
      setIssues([{ path: "image", message: "That image is over 2 MB. Pick a smaller one." }]);
      return;
    }
    // Show it immediately off the local `File`, then upload. The preview is the
    // same bytes either way, so a slow bucket costs the user nothing visible.
    const previewUrl = URL.createObjectURL(file);
    const alt = name.trim();
    setImage({ previewUrl, uploadId: null, alt });
    const uploadId = await uploadRecipeImage(file);
    if (!uploadId) {
      URL.revokeObjectURL(previewUrl);
      setImage(null);
      setIssues([{ path: "image", message: "That photo could not be uploaded. Try another one." }]);
      return;
    }
    setImage({ previewUrl, uploadId, alt });
  }

  const previewData: RecipeViewData = useMemo(() => {
    const built = buildAttribution(attr);
    const attrUrl = imported ? sourceUrl : ((built?.url as string | undefined) ?? null);
    const source = deriveSource({
      origin: "local",
      id: "",
      repoHandle: null,
      attrDisplayName: (built?.name as string) ?? (built?.title as string) ?? null,
      attrAuthor: (built?.author as string) ?? null,
      attrPublisher: (built?.publisher as string) ?? null,
      attrUrl: attrUrl,
    });
    return {
      title: name,
      description: text.trim() || null,
      images: image && imageSrc ? [{ url: imageSrc, alt: image.alt }] : [],
      ingredients,
      instructions,
      keywords,
      totalTimeDisplay: null,
      category: RECIPE_VOCAB.category.find((c) => c.slug === category)?.label ?? null,
      source,
      nutrition: {
        calories: calories ? Number(calories) : null,
        protein: protein ? Number(protein) : null,
        carbs: carbs ? Number(carbs) : null,
        fat: fat ? Number(fat) : null,
      },
      serves: null,
    };
  }, [name, text, image, imageSrc, ingredients, instructions, keywords, category, calories, protein, fat, carbs, attr, imported, sourceUrl]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-6 px-4 pt-8 pb-12">
        {/* Header */}
        <header className="flex flex-col items-start">
          <button
            onClick={() => navigate({ to: "/household/recipes" })}
            className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to the recipe box
          </button>
          <Badge variant="secondary" size="xs" className="mb-3">
            {imported ? (
              <>
                <Link2 className="size-3" aria-hidden="true" />
                Imported from {importHost ?? "the web"}
              </>
            ) : (
              "Entered by hand"
            )}
          </Badge>
          <h1 className="display-title m-0 text-[2.25rem] leading-[1.1]">{imported ? "Check the import" : "A new recipe"}</h1>
          {imported && (
            <p className="mt-3 max-w-[38rem] text-base text-muted-foreground text-pretty">
              Review the details below and fix anything that didn't come through. The credit in the rail stays locked to the source URL.
            </p>
          )}
        </header>

        {/* Re-authorization prompt — the draft is saved, only the PDS write failed. */}
        {needsReauth && (
          <div className="flex items-start gap-3 rounded-lg border-2 border-border bg-card px-3.5 py-3 shadow-(--shadow-pop-sm)">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="flex flex-col items-start gap-2">
              <div className="text-sm font-semibold text-foreground">Buttery needs new permissions on your atproto account</div>
              <p className="m-0 text-sm text-muted-foreground">
                Your recipe is saved here as a draft. Publishing writes it to your own account, and that permission was added after you last signed in — reconnect to grant it, then
                publish again.
              </p>
              <Button size="sm" disabled={reauthPending} onClick={onReconnect}>
                {reauthPending ? <Spinner /> : null}
                Reconnect account
              </Button>
            </div>
          </div>
        )}

        {/* Error summary */}
        {issues.length > 0 && (
          <div className="flex items-start gap-3 rounded-lg border-2 border-destructive bg-[color-mix(in_oklab,var(--destructive)_8%,var(--card))] px-3.5 py-3 shadow-(--shadow-pop-sm)">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
            <div>
              <div className="text-sm font-semibold text-foreground">{issues.length === 1 ? "One thing needs a look" : `${issues.length} things need a look`}</div>
              <ul className="mt-1 mb-0 flex list-disc flex-col gap-0.5 pl-4 text-sm text-muted-foreground">
                {issues.map((iss, i) => (
                  <li key={i}>
                    {iss.path ? <span className="font-semibold text-foreground">{iss.path}: </span> : null}
                    {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          {/* Main column */}
          <div className="flex min-w-0 flex-col gap-5">
            <Card>
              <CardHeader>
                <CardTitle className="display-title">
                  <span className="flex items-center gap-2 text-lg">
                    <BookOpenText className="size-5" aria-hidden="true" />
                    The basics
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-[1fr_240px]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-2">
                      <label htmlFor="f-name" className="bt-label">
                        Name
                      </label>
                      <Input id="f-name" size="lg" value={name} onChange={(e) => setName(e.target.value)} placeholder="Brown butter chocolate chip cookies" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <label htmlFor="f-text" className="bt-label">
                        Description
                      </label>
                      <Textarea
                        id="f-text"
                        rows={4}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="A line or two about what this is and why you keep making it."
                      />
                      <p className="bt-field-description m-0">Shows under the title on the recipe page.</p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="bt-label">Photo</label>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && void onPickFile(e.target.files[0])} />
                    {image ? (
                      <div className="flex flex-col gap-2">
                        <div className="aspect-[4/3] w-full overflow-hidden rounded-lg border-2 border-border">
                          <img src={imageSrc ?? ""} alt="" className="size-full object-cover" />
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                            Replace
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setImage(null)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted text-muted-foreground">
                        <UtensilsCrossed className="size-10" aria-hidden="true" />
                        <span className="text-xs font-semibold">Add a photo</span>
                        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                          Choose a file
                        </Button>
                      </div>
                    )}
                    <p className="bt-field-description m-0">One photo, up to 1&nbsp;MB. Held with the recipe and uploaded to your atproto repo when you publish.</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="display-title">
                  <span className="flex items-center gap-2 text-lg">
                    <ShoppingBasket className="size-5" aria-hidden="true" />
                    Ingredients
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <IngredientsEditor lines={ingredients} onChange={setIngredients} mode={ingMode} onModeChange={setIngMode} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="display-title">
                  <span className="flex items-center gap-2 text-lg">
                    <CookingPot className="size-5" aria-hidden="true" />
                    Instructions
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <InstructionsEditor lines={instructions} onChange={setInstructions} mode={insMode} onModeChange={setInsMode} />
              </CardContent>
            </Card>

            <Accordion type="multiple">
              <AccordionItem value="times">
                <AccordionTrigger>
                  <Clock className="size-4" aria-hidden="true" />
                  Times &amp; yield
                  <span className="ml-2 text-sm font-normal text-muted-foreground">Optional</span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid max-w-[44rem] grid-cols-2 gap-4 sm:grid-cols-3">
                    <NumField label="Prep (min)" value={prep} onChange={setPrep} />
                    <NumField label="Cook (min)" value={cook} onChange={setCook} />
                    <div className="flex flex-col gap-2">
                      <label className="bt-label">Yield</label>
                      <Input value={recipeYield} onChange={(e) => setRecipeYield(e.target.value)} placeholder="24 cookies" />
                    </div>
                  </div>
                  <p className="bt-field-description mt-3 mb-0">Stored as ISO-8601 durations in the record.</p>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="vocab">
                <AccordionTrigger>
                  <Compass className="size-4" aria-hidden="true" />
                  Cuisine, category, method &amp; diet
                  <span className="ml-2 text-sm font-normal text-muted-foreground">Optional · helps the randomizer later</span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid max-w-[52rem] grid-cols-2 gap-4 sm:grid-cols-4">
                    <VocabField label="Cuisine" dim="cuisine" value={cuisine} onChange={setCuisine} />
                    <VocabField label="Category" dim="category" value={category} onChange={setCategory} />
                    <VocabField label="Method" dim="cooking_method" value={method} onChange={setMethod} />
                    <VocabField label="Suitable for diet" dim="diet" value={diet} onChange={setDiet} />
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="keywords">
                <AccordionTrigger>
                  <Link2 className="size-4" aria-hidden="true" />
                  Keywords
                  <span className="ml-2 text-sm font-normal text-muted-foreground">Optional · {keywords.length} added</span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-wrap items-center gap-2">
                    {keywords.map((k, i) => (
                      <Badge key={i} variant="secondary" size="sm">
                        {k}
                        <button
                          type="button"
                          onClick={() => setKeywords(keywords.filter((_, j) => j !== i))}
                          aria-label={`Remove ${k}`}
                          className="ml-0.5 inline-flex items-center"
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </Badge>
                    ))}
                    <div className="grid w-64 min-w-0">
                      <Input
                        size="sm"
                        placeholder="Add a keyword and press enter"
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          const v = e.currentTarget.value.trim();
                          if (v && !keywords.includes(v)) setKeywords([...keywords, v]);
                          e.currentTarget.value = "";
                        }}
                      />
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="nutrition">
                <AccordionTrigger>
                  <CookingPot className="size-4" aria-hidden="true" />
                  Nutrition
                  <span className="ml-2 text-sm font-normal text-muted-foreground">Optional · per serving</span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid max-w-[52rem] grid-cols-2 gap-4 sm:grid-cols-4">
                    <NumField label="Calories" value={calories} onChange={setCalories} placeholder="210" />
                    <NumField label="Protein (g)" value={protein} onChange={setProtein} placeholder="3" />
                    <NumField label="Fat (g)" value={fat} onChange={setFat} placeholder="11" />
                    <NumField label="Carbs (g)" value={carbs} onChange={setCarbs} placeholder="26" />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          {/* Right rail */}
          <div className="flex flex-col gap-4 lg:sticky lg:top-4">
            <AttributionCard
              state={attr}
              onChange={setAttr}
              locked={imported && sourceUrl ? { name: importHost ?? sourceUrl, url: sourceUrl } : null}
              onStartOver={() => setSourceUrl(null)}
            />

            <div className="flex flex-col gap-3 rounded-xl border-2 border-border bg-card p-3.5 shadow-(--shadow-pop-md)">
              <div className="flex items-center gap-2">
                <BookOpenText className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-bold">Where it lands</span>
              </div>
              <p className="m-0 text-sm text-muted-foreground">
                A private recipe in <strong className="text-foreground">{householdName}</strong>. Nothing leaves your account until you publish.
              </p>
              <Separator />
              <div className="flex flex-col gap-2">
                <Button variant="outline" onClick={() => setPreviewOpen(true)}>
                  <Eye data-icon="inline-start" aria-hidden="true" />
                  Preview
                </Button>
                {/* Primary action follows intent: entering by hand → keep it
                    private; reviewing an import → publish it. */}
                <Button variant={imported ? "outline" : "default"} disabled={saveDisabled} onClick={() => submit(false)}>
                  {pending === "draft" ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" aria-hidden="true" />}
                  Save privately
                </Button>
                <Button variant={imported ? "default" : "outline"} disabled={saveDisabled} onClick={() => setConfirmPublish(true)}>
                  {pending === "publish" ? <Spinner data-icon="inline-start" /> : <BookOpenText data-icon="inline-start" aria-hidden="true" />}
                  Save &amp; publish
                </Button>
                <Button variant="ghost" onClick={() => navigate({ to: "/household/recipes" })}>
                  Cancel
                </Button>
              </div>
              {!attrDone && <p className="m-0 text-xs font-semibold text-destructive">Saving unlocks once the attribution is complete.</p>}
            </div>
          </div>
        </div>
      </div>

      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} data={previewData} />
      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title="Publish this recipe?"
        description="This makes the recipe public on atproto — a portable record in your repo that other apps can read. It's hard to undo."
        confirmLabel="Publish"
        pending={pending === "publish"}
        onConfirm={() => {
          setConfirmPublish(false);
          void submit(true);
        }}
      />
      <DuplicateDialog open={duplicateId != null} onOpenChange={(o) => !o && setDuplicateId(null)} existingRecipeId={duplicateId} />
    </div>
  );
}

function NumField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="bt-label">{label}</label>
      <Input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function VocabField({ label, dim, value, onChange }: { label: string; dim: keyof typeof RECIPE_VOCAB; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="bt-label">{label}</label>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">None</option>
        {RECIPE_VOCAB[dim].map((o) => (
          <option key={o.slug} value={o.slug}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
