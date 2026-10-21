import { registerNoopSkill } from "./noop";
import type { McpServer } from "@modelcontextprotocol/server";

// One entry per skill (tools / prompts / resources). Add a file beside this one
// exporting a `register*Skill(server)` and list it here.
export const skills: ReadonlyArray<(server: McpServer) => void> = [registerNoopSkill];
