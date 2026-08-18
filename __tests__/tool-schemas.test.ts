import { describe, expect, test } from "bun:test";

import inspectTool from "../tools/shared-memory-inspect.js";
import publishTool from "../tools/shared-memory-publish.js";

/**
 * Guards on the tool schemas the assistant sends to the model provider.
 *
 * A tool schema is not just this plugin's business. The provider validates the
 * whole tool array on every turn and rejects the entire request when one entry
 * is malformed — so a bad schema here does not degrade one tool, it stops the
 * assistant answering at all, in every conversation, for as long as the plugin
 * is installed. The failure names a tool by index (`tools.13.custom.
 * input_schema`), which points at a position in a list the user cannot see.
 *
 * That happened: `shared_memory_inspect` declared a top-level `oneOf` and took
 * a working assistant down the moment the plugin was installed.
 */

const TOOLS = [
  { name: "shared_memory_inspect", tool: inspectTool },
  { name: "shared_memory_publish", tool: publishTool },
];

/** Rejected by the Anthropic API when they appear at the schema's top level. */
const FORBIDDEN_AT_TOP_LEVEL = ["oneOf", "allOf", "anyOf", "not"];

describe.each(TOOLS)("$name input_schema", ({ tool }) => {
  const schema = tool.input_schema as Record<string, unknown>;

  test("is an object schema", () => {
    expect(schema.type).toBe("object");
  });

  test.each(FORBIDDEN_AT_TOP_LEVEL)("has no top-level %s", (keyword) => {
    expect(schema).not.toHaveProperty(keyword);
  });

  test("is JSON-serializable, since it is sent on the wire", () => {
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});

describe("shared_memory_inspect", () => {
  /**
   * The constraint the removed `oneOf` used to express still has to reach the
   * model somehow, or it will guess. Descriptions are the only channel left.
   */
  test("states the mutually-exclusive rule in its description", () => {
    expect(inspectTool.description).toContain("exactly one of query or paths");
  });

  test("states it on both properties too", () => {
    const properties = (inspectTool.input_schema as { properties: Record<string, { description: string }> })
      .properties;
    expect(properties.query!.description).toContain("Mutually exclusive with paths");
    expect(properties.paths!.description).toContain("Mutually exclusive with query");
  });
});
