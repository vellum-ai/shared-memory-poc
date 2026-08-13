/**
 * `init` hook: prepare the install's filesystem layout once per boot.
 *
 * The runtime catches whatever this hook throws and carries on, but it logs
 * only a generic message, so the whole body is guarded here to report each
 * failure with the paths it happened on. A half-prepared workspace costs the
 * team its shared content and nothing more.
 */

import { dirname, resolve } from "node:path";

import type { InitContext } from "@vellumai/plugin-api";

import {
  ensureGitExclude,
  ensureSkillsSymlink,
  untrackPluginPath,
} from "../src/workspace-setup.js";

/** Where the assistant installs this plugin, relative to the workspace root. */
const PLUGIN_REL_PATH = "plugins/shared-memory";

/**
 * The install is a git clone, so the plugin directory carries its own `.git`.
 * Excluding the whole directory keeps that nested repo out of the workspace's
 * history; excluding only `data/` would leave a gitlink behind instead.
 */
const EXCLUDE_LINE = `/${PLUGIN_REL_PATH}/`;

export default async function init(ctx: InitContext): Promise<void> {
  try {
    const pluginDir = dirname(ctx.pluginStorageDir);
    const workspaceRoot = resolve(pluginDir, "..", "..");

    const exclude = ensureGitExclude(workspaceRoot, EXCLUDE_LINE);
    ctx.logger.info(
      { workspaceRoot, result: exclude },
      "Checked the workspace git exclude for the plugin directory",
    );

    // The exclude goes first so nothing can re-add the path in between.
    const untrack = untrackPluginPath(workspaceRoot, PLUGIN_REL_PATH);
    if (untrack === "failed") {
      ctx.logger.warn(
        { workspaceRoot },
        "Could not drop the plugin directory from the workspace's git index, so the workspace will keep reporting it as changed",
      );
    } else {
      ctx.logger.info(
        { workspaceRoot, result: untrack },
        "Checked whether the workspace's git index still tracks the plugin directory",
      );
    }

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
