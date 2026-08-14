import { fileURLToPath } from "node:url";

import { handleKnowledgePage } from "../../src/knowledge/page.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description = "The Markdown of one concepts/**/*.md page at the clone's HEAD.";

export function GET(request: Request): Promise<Response> {
  return handleKnowledgePage(request, PLUGIN_DIR);
}
