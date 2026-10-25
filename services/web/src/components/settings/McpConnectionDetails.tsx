import { useEffect, useState } from "react";
import { Check, Copy, Info, Link2 } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Field, FieldLabel } from "#/components/ui/field";
import { Infotip, InfotipContent, InfotipTrigger } from "#/components/ui/infotip";
import { Separator } from "#/components/ui/separator";
import { McpConnectedApps } from "./McpConnectedApps";
import type { McpConnection } from "#/lib/api";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "#/components/ui/input-group";

/** Buttery's MCP connector: where it lives, and how apps prove who's asking. */
export function McpConnectionDetails({ serverUrl, connections }: { serverUrl: string; connections: McpConnection[] | null }) {
  const [copied, setCopied] = useState(false);

  // Flip the icon back after a beat. The cleanup also cancels it on unmount.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(serverUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title text-xl">
          AI Agents
        </CardTitle>
        <CardDescription>Add Buttery MCP to an AI app and it can work with your Buttery account on your behalf.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
          <dt className="font-semibold text-muted-foreground">Name</dt>
          <dd className="m-0 text-foreground">Buttery</dd>
          <dt className="font-semibold text-muted-foreground">Sign-in</dt>
          <dd className="m-0 flex items-center gap-1.5">
            <Badge variant="secondary" size="sm">
              OAuth
            </Badge>
            <Infotip>
              <InfotipTrigger
                aria-label="About signing in"
                className="inline-flex size-5 cursor-pointer touch-manipulation items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Info className="size-4" aria-hidden="true" />
              </InfotipTrigger>
              <InfotipContent>You'll be asked to sign in to Buttery to finish adding the connector.</InfotipContent>
            </Infotip>
          </dd>
        </dl>

        <Field>
          <FieldLabel htmlFor="mcp-server-url">Server URL</FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <Link2 aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput id="mcp-server-url" readOnly value={serverUrl} spellCheck={false} autoComplete="off" className="font-mono" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => void onCopy()} aria-label={copied ? "Server URL copied" : "Copy server URL"}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <p className="sr-only" role="status">
            {copied ? "Server URL copied to clipboard" : ""}
          </p>
        </Field>

        <Separator />

        <McpConnectedApps connections={connections} />
      </CardContent>
    </Card>
  );
}
