import { fileURLToPath } from "node:url";

import { handleKnowledgeSearch } from "../../src/knowledge/search.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description = "Concept pages containing the literal ?q text, with an excerpt each.";

export function GET(request: Request): Promise<Response> {
  return handleKnowledgeSearch(request, PLUGIN_DIR);
}
