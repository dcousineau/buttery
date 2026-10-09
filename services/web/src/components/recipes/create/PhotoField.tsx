import { useEffect, useMemo, useRef, useState } from "react";
import { Check, UtensilsCrossed } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { copyRemoteImageViaServer, fetchRemoteImage, uploadRecipeImage } from "#/lib/recipe-image-upload";
import { MAX_IMAGE_BYTES, isAllowedImageMime } from "#/lib/recipe-image";

/**
 * Only `ready` is ever previewed as the recipe's photo, and its `previewUrl` is the
 * bucket's copy — so what the user sees is what the save will point at. While
 * uploading, the local bytes are shown faded as a progress indicator.
 */
export type PhotoState =
  | { status: "empty" }
  | { status: "fetching" }
  | { status: "uploading"; localUrl: string; progress: number }
  | { status: "ready"; uploadId: string; previewUrl: string; sourceUrl?: string };

const EMPTY: PhotoState = { status: "empty" };

function loads(url: string): Promise<boolean> {
  const img = new Image();
  img.src = url;
  return img.decode().then(
    () => true,
    () => false,
  );
}

export function useRecipePhoto() {
  const [state, setState] = useState<PhotoState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);

  useEffect(() => () => run.current?.abort(), []);

  const actions = useMemo(() => {
    function begin(): AbortSignal {
      run.current?.abort();
      run.current = new AbortController();
      setError(null);
      return run.current.signal;
    }

    async function upload(blob: Blob, signal: AbortSignal, sourceUrl?: string) {
      const localUrl = URL.createObjectURL(blob);
      setState({ status: "uploading", localUrl, progress: 0 });
      try {
        const uploaded = await uploadRecipeImage(blob, {
          signal,
          onProgress: (progress) => !signal.aborted && setState({ status: "uploading", localUrl, progress }),
        });
        const shown = uploaded != null && (await loads(uploaded.previewUrl));
        if (signal.aborted) return;
        if (!uploaded || !shown) {
          setState(EMPTY);
          setError(uploaded ? "That photo uploaded but won't display. Try a JPEG or PNG." : "That photo could not be uploaded. Try another one.");
          return;
        }
        setState({ status: "ready", ...uploaded, sourceUrl });
      } finally {
        URL.revokeObjectURL(localUrl);
      }
    }

    return {
      pickFile: (file: File) => {
        if (file.size > MAX_IMAGE_BYTES) return setError("That image is over 2 MB. Pick a smaller one.");
        if (!isAllowedImageMime(file.type)) return setError("That file type isn't supported. Try a JPEG, PNG or WebP.");
        void upload(file, begin());
      },
      stageRemote: async (url: string, host: string | null) => {
        const signal = begin();
        setState({ status: "fetching" });
        const blob = await fetchRemoteImage(url, signal);
        if (signal.aborted) return;
        if (blob) return upload(blob, signal, url);
        // The two fetchers fail on disjoint sets of hosts, so a browser refusal is not the
        // end of it: a tab dies on a missing `Access-Control-Allow-Origin`, our backend dies
        // on hotlink protection keyed to Referer and datacenter IPs. Browser first because it
        // carries the user's own cookies and IP; the server picks up what CORS locked out.
        const copied = await copyRemoteImageViaServer(url);
        if (signal.aborted) return;
        // Only a bucket copy that actually decodes may become `ready`.
        const shown = copied != null && (await loads(copied.previewUrl));
        if (signal.aborted) return;
        if (!copied || !shown) {
          setState(EMPTY);
          setError(`Couldn't copy the photo from ${host ?? "the source"}. Add one by hand.`);
          return;
        }
        setState({ status: "ready", ...copied, sourceUrl: url });
      },
      clear: () => {
        begin();
        setState(EMPTY);
      },
    };
  }, []);

  return { state, error, busy: state.status === "fetching" || state.status === "uploading", ...actions };
}

export function PhotoField({ photo }: { photo: ReturnType<typeof useRecipePhoto> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { state, error } = photo;
  const choose = () => fileRef.current?.click();

  return (
    <div className="flex flex-col gap-2">
      <span className="bt-label">Photo</span>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) photo.pickFile(file);
        }}
      />
      {state.status === "empty" ? (
        <div className="flex aspect-4/3 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted text-muted-foreground">
          <UtensilsCrossed className="size-10" aria-hidden="true" />
          <span className="text-xs font-semibold">Add a photo</span>
          <Button variant="outline" size="sm" onClick={choose}>
            Choose a file
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <PhotoFrame state={state} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={choose}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={photo.clear}>
              Remove
            </Button>
          </div>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {state.status === "fetching" ? "Copying the photo…" : state.status === "uploading" ? "Uploading the photo…" : state.status === "ready" ? "Photo uploaded." : ""}
      </p>
      {error && <p className="m-0 text-xs font-semibold text-destructive">{error}</p>}
      <p className="bt-field-description m-0">One photo, up to 2&nbsp;MB. Held with the recipe and uploaded to your atproto repo when you publish.</p>
    </div>
  );
}

function PhotoFrame({ state }: { state: Exclude<PhotoState, { status: "empty" }> }) {
  const frame = "relative aspect-4/3 w-full overflow-hidden rounded-lg border-2 border-border bg-muted";
  if (state.status === "fetching") {
    return (
      <div className={`${frame} flex items-center justify-center gap-2 text-xs font-semibold text-muted-foreground`}>
        <Spinner aria-hidden="true" />
        Copying the photo…
      </div>
    );
  }
  if (state.status === "uploading") {
    const pct = Math.round(state.progress * 100);
    return (
      <div className={frame} role="progressbar" aria-label="Uploading photo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <img src={state.localUrl} alt="" className="size-full object-cover opacity-40" />
        <img
          src={state.localUrl}
          alt=""
          className="absolute inset-0 size-full object-cover transition-[clip-path] duration-200 ease-linear"
          style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
        />
      </div>
    );
  }
  return (
    <div className={frame}>
      <img src={state.previewUrl} alt="" className="size-full object-cover" />
      <span
        title="Uploaded"
        className="absolute right-2 bottom-2 grid size-6 place-items-center rounded-full border-2 border-border bg-primary text-primary-foreground shadow-(--shadow-pop-sm)"
      >
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    </div>
  );
}
