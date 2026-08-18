import { fileURLToPath } from "node:url";

import { handleSetupStatus } from "../../src/setup/handlers.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description =
  "Whether this install has finished setup, and which step it is stuck on.";

export function GET(): Promise<Response> {
  return handleSetupStatus(PLUGIN_DIR);
}
