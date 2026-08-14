import { fileURLToPath } from "node:url";

import { handleKnowledgePending } from "../../src/knowledge/pending.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description = "What the next digest notification would report, as the digest sees it.";

export function GET(request: Request): Promise<Response> {
  return handleKnowledgePending(request, PLUGIN_DIR);
}
