import { fileURLToPath } from "node:url";

import { handleSetupSync } from "../../src/setup/handlers.js";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const description = "Run one sync now instead of waiting for the schedule.";

export function POST(): Promise<Response> {
  return handleSetupSync(PLUGIN_DIR);
}
