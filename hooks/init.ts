/**
 * `init` hook: prepare the install's filesystem layout once per boot.
 *
 * A throw here aborts the plugin's load, so the whole body is guarded and
 * every failure is logged instead. A half-prepared workspace only costs the
 * team its shared content; it must never take the plugin down.
 */

import { dirname, resolve } from "node:path";

import type { InitContext } from "@vellumai/plugin-api";

import {
  ensureGitExclude,
  ensureSkillsSymlink,
} from "../src/workspace-setup.js";

/**
 * The install is a git clone, so the plugin directory carries its own `.git`.
 * Excluding the whole directory keeps that nested repo out of the workspace's
 * history; excluding only `data/` would leave a gitlink behind instead.
 */
const EXCLUDE_LINE = "/plugins/shared-memory/";

export default async function init(ctx: InitContext): Promise<void> {
  try {
    const pluginDir = dirname(ctx.pluginStorageDir);
    const workspaceRoot = resolve(pluginDir, "..", "..");

    const exclude = ensureGitExclude(workspaceRoot, EXCLUDE_LINE);
    ctx.logger.info(
      { workspaceRoot, result: exclude },
      "Checked the workspace git exclude for the plugin directory",
    );

    const link = ensureSkillsSymlink(pluginDir);
    if (link === "conflict") {
      ctx.logger.warn(
        { pluginDir },
        "A real skills/ directory is in the way, so shared skills will not sync until it is removed",
      );
    } else {
      ctx.logger.info(
        { pluginDir, result: link },
        "Checked the skills symlink into the content repo clone",
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error },
      "Could not prepare the plugin directory, so shared content will not sync",
    );
  }
}
