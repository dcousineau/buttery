import { createFileRoute } from "@tanstack/react-router";
import { McpConnectionDetails } from "#/components/settings/McpConnectionDetails";
import { McpSetupInstructions } from "#/components/settings/McpSetupInstructions";
import { getMcpConnections } from "#/lib/api";
import { seo, siteUrl } from "../lib/seo";

export const Route = createFileRoute("/settings/connections")({
  // siteUrl() is the build-time public origin (VITE_APP_URL, 127.0.0.1:3000 in dev), so the
  // server render and the client agree and each environment shows its own address.
  loader: async () => ({
    mcpUrl: `${siteUrl()}/mcp`,
    // A failed lookup shows an inline message in the card rather than taking the page down.
    connections: await getMcpConnections().catch(() => null),
  }),
  head: () => ({
    meta: seo({ title: "Connections · Buttery", description: "Connect Buttery to your AI apps." }),
  }),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const { mcpUrl, connections } = Route.useLoaderData();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col">
        <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground">Connections</h1>
        <p className="mt-3 mb-0 text-sm text-muted-foreground sm:text-base">
          Let the AI apps you already use work with your Buttery account. You choose what each app can do when you approve it.
        </p>
      </header>
      <McpConnectionDetails serverUrl={mcpUrl} connections={connections} />
      <McpSetupInstructions />
    </div>
  );
}
