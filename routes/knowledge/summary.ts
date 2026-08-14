import { fileURLToPath } from "node:url";

import { handleKnowledgeSummary } from "../../src/knowledge/summary.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description =
  "Configuration, sync state and entity counts for each shared knowledge base.";

export function GET(request: Request): Promise<Response> {
  return handleKnowledgeSummary(request, PLUGIN_DIR);
}
