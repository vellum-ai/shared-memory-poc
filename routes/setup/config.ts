import { fileURLToPath } from "node:url";

import { handleSetupConfig } from "../../src/setup/handlers.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description = "Set the shared content repository, branch and publishing author.";

export function POST(request: Request): Promise<Response> {
  return handleSetupConfig(request, PLUGIN_DIR);
}
