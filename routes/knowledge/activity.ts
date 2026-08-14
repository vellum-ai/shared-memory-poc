import { fileURLToPath } from "node:url";

import { handleKnowledgeActivity } from "../../src/knowledge/activity.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description =
  "Weekly skill and page changes by author, with the most recent commits, over the last ?days.";

export function GET(request: Request): Promise<Response> {
  return handleKnowledgeActivity(request, PLUGIN_DIR);
}
