import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { registerRecipeSchemaSkill } from "./recipe-schema";

type Handler = (args: Record<string, unknown>) => unknown;

function setup() {
  const resources: string[] = [];
  const tools = new Map<string, Handler>();
  const server = new McpServer({ name: "t", version: "0" });
  const original = {
    resource: server.registerResource.bind(server),
    tool: server.registerTool.bind(server),
  };
  // Capture registrations; the handlers are what we want to call.
  (server as unknown as { registerResource: unknown }).registerResource = (name: string, ...rest: unknown[]) => {
    resources.push(name);
    return (original.resource as (...a: unknown[]) => unknown)(name, ...rest);
  };
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: unknown, handler: Handler) => {
    tools.set(name, handler);
    return (original.tool as (...a: unknown[]) => unknown)(name, config, handler);
  };
  registerRecipeSchemaSkill(server);
  return { resources, tools };
}

describe("recipe schema skill", () => {
  it("exposes the recipe lexicons as resources", () => {
    const { resources } = setup();
    expect(resources).toEqual(expect.arrayContaining(["exchange.recipe.recipe", "exchange.recipe.collection", "exchange.recipe.defs", "exchange.recipe.profile"]));
  });

  it("returns the recipe lexicon JSON by default and errors on an unknown nsid", () => {
    const { tools } = setup();
    const ok = tools.get("get_recipe_schema")!({}) as { content: { text: string }[] };
    expect((JSON.parse(ok.content[0].text) as { id: string }).id).toBe("exchange.recipe.recipe");
    expect(tools.get("get_recipe_schema")!({ nsid: "nope" })).toMatchObject({ isError: true });
  });

  it("validates a recipe record", () => {
    const { tools } = setup();
    const validate = tools.get("validate_recipe")!;
    expect(validate({ record: { $type: "exchange.recipe.recipe" } })).toMatchObject({ isError: true });
  });

  it("requires a source even though the lexicon does not", () => {
    const { tools } = setup();
    const validate = tools.get("validate_recipe")!;
    const record = { name: "Toast", text: "Bread, heated.", ingredients: ["1 slice bread"], instructions: ["Toast it."] };
    const noSource = validate({ record }) as { isError?: boolean; content: { text: string }[] };
    expect(noSource.isError).toBe(true);
    expect(noSource.content[0].text).toContain("attribution");
    expect(validate({ record, sourceUrl: "https://example.com/toast" })).toEqual({ content: [{ type: "text", text: "Valid." }] });
  });
});
