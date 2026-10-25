import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "#/components/ui/accordion";
import type { ReactNode } from "react";

function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-sm text-foreground marker:font-semibold marker:text-muted-foreground">{children}</ol>;
}

/**
 * Per-app setup steps. Menu names drift between releases, so each step says where to
 * look rather than promising an exact label.
 */
export function McpSetupInstructions() {
  return (
    <section aria-labelledby="mcp-setup-heading" className="flex flex-col gap-3">
      <h2 id="mcp-setup-heading" className="display-title m-0 text-xl">
        Set it up in your app
      </h2>
      <Accordion type="single" defaultOpen={["claude"]}>
        <AccordionItem value="claude">
          <AccordionTrigger>Claude</AccordionTrigger>
          <AccordionContent>
            <Steps>
              <li>Open Claude on the web or in the desktop app and head to Settings.</li>
              <li>Look for Connectors, then choose to add a custom connector.</li>
              <li>Give it a name like Buttery and paste the server URL from above.</li>
              <li>Save it, then choose Connect. You'll come back to Buttery to sign in and approve access.</li>
              <li>Start a chat and turn the Buttery connector on for it.</li>
            </Steps>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="chatgpt">
          <AccordionTrigger>ChatGPT</AccordionTrigger>
          <AccordionContent>
            <Steps>
              <li>Open ChatGPT and head to Settings.</li>
              <li>Look for Connectors (or Apps), and switch on developer mode if you don't see an option to add your own.</li>
              <li>Choose to create a custom connector, name it Buttery, and paste the server URL from above.</li>
              <li>Pick OAuth for sign-in if it asks, then create the connector. You'll come back to Buttery to sign in and approve access.</li>
              <li>Start a chat and add the Buttery connector to it.</li>
            </Steps>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <p className="m-0 text-xs text-muted-foreground">
        Custom connectors may not be available on every plan, and menus change now and then, so your app may word things a little differently.
      </p>
    </section>
  );
}
