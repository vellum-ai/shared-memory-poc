import { fileURLToPath } from "node:url";

import { handleSetupCredential } from "../../src/setup/handlers.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description =
  "Store the GitHub token in the assistant's vault and check it against the repository.";

export function POST(request: Request): Promise<Response> {
  return handleSetupCredential(request, PLUGIN_DIR);
}
