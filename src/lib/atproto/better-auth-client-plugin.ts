import type { BetterAuthClientPlugin } from "better-auth/client";
import type { atprotoPlugin } from "./better-auth-plugin";

export const atprotoClient = () => {
  return {
    id: "atproto",
    $InferServerPlugin: {} as ReturnType<typeof atprotoPlugin>,
    pathMethods: {
      "/atproto/sign-in": "POST",
    },
  } satisfies BetterAuthClientPlugin;
};
