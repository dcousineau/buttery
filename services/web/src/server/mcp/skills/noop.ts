import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

// Placeholder skill. Replace with real tools; this only proves the wiring
// (auth → handler → tool call) works end to end.
export function registerNoopSkill(server: McpServer): void {
  server.registerTool(
    "noop",
    {
      description: "Placeholder tool that echoes its input. Does nothing else.",
      inputSchema: z.object({ message: z.string().optional() }),
    },
    ({ message }) => ({
      content: [{ type: "text", text: message ?? "noop" }],
    }),
  );
}
