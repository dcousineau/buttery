/// <reference types="vite/client" />

/**
 * Vite's own `ImportMetaEnv` is `[key: string]: any`, so every `import.meta.env.X`
 * read is an `any` that silently infects whatever it flows into (type-aware lint
 * catches this as `no-unsafe-*`). Declaring the vars we actually inline gives them
 * real types; they are optional because a bundle can be built without them set.
 */
interface ImportMetaEnv {
  readonly VITE_APP_URL?: string;
  readonly VITE_PUBLIC_POSTHOG_ENABLED?: string;
  readonly VITE_PUBLIC_POSTHOG_HOST?: string;
  readonly VITE_PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
}
