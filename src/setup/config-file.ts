/**
 * Read and merge-write the plugin's `config.json` for the setup flow.
 *
 * The sync schedule writes this file too — it fills in a missing `author` block
 * from the guardian contact — so every write here is a read-modify-write onto a
 * temp file followed by a rename, and unknown keys are carried through
 * untouched. A setup step that rewrote the file wholesale would drop
 * `sharingGuidance`, the `digest` block, and anything a future version adds.
 *
 * Validation mirrors `readRepositoryConfig`, which is the reader that actually
 * gates sync. Accepting a value here that the reader later rejects would report
 * setup as finished and then fail on the first sync, which is the one outcome
 * this flow exists to prevent.
 */

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class SetupConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SetupConfigError";
  }
}

export interface ConfigAuthor {
  name: string;
  email: string;
}

export interface ConfigPatch {
  repoUrl?: string;
  branch?: string;
  author?: ConfigAuthor;
}

const MAX_URL_BYTES = 2_048;
const MAX_BRANCH_BYTES = 255;
const MAX_AUTHOR_BYTES = 320;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function configPath(pluginDir: string): string {
  return join(pluginDir, "config.json");
}

/**
 * The config as an object, or an empty object when the file is absent. A
 * missing config is the normal state of a fresh install, which is exactly when
 * the setup flow runs, so it is not an error. A file that exists but does not
 * parse is an error, because overwriting it would destroy whatever the user
 * meant to put there.
 */
export async function readRawConfig(pluginDir: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath(pluginDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new SetupConfigError("CONFIG_UNREADABLE", "The plugin's config.json could not be read.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupConfigError(
      "CONFIG_INVALID",
      "The plugin's config.json is not valid JSON, so setup will not overwrite it. Fix or remove the file and try again.",
    );
  }
  if (!isRecord(parsed)) {
    throw new SetupConfigError(
      "CONFIG_INVALID",
      "The plugin's config.json must contain a JSON object.",
    );
  }
  return parsed;
}

function validateRepoUrl(value: string): string {
  const repoUrl = value.trim();
  if (repoUrl.length === 0) {
    throw new SetupConfigError("INVALID_REPO_URL", "A repository URL is required.");
  }
  if (repoUrl.includes("\0") || byteLength(repoUrl) > MAX_URL_BYTES) {
    throw new SetupConfigError("INVALID_REPO_URL", "That repository URL is not valid.");
  }
  return repoUrl;
}

/**
 * Branch rules match the reader's, including its refusal of a leading `-`,
 * which would otherwise reach git as an option rather than a ref.
 */
function validateBranch(value: string): string {
  const branch = value.trim();
  if (
    branch.length === 0 ||
    byteLength(branch) > MAX_BRANCH_BYTES ||
    branch.startsWith("-") ||
    branch.includes("\0")
  ) {
    throw new SetupConfigError("INVALID_BRANCH", "That branch name is not valid.");
  }
  return branch;
}

function validateAuthor(author: ConfigAuthor): ConfigAuthor {
  const name = author.name.trim();
  const email = author.email.trim();
  if (name.length === 0 || byteLength(name) > MAX_AUTHOR_BYTES || /[\0\n<>]/.test(name)) {
    throw new SetupConfigError("INVALID_AUTHOR", "That author name is not valid.");
  }
  // Deliberately loose: git does not validate addresses either, and the only
  // shapes worth refusing are the ones that would corrupt a commit trailer.
  if (
    email.length === 0 ||
    byteLength(email) > MAX_AUTHOR_BYTES ||
    /[\0\s<>]/.test(email) ||
    !email.includes("@")
  ) {
    throw new SetupConfigError("INVALID_AUTHOR", "That author email is not valid.");
  }
  return { name, email };
}

/**
 * Apply `patch` to `config.json` and return the merged object.
 *
 * The temp file sits beside the target so the rename stays on one filesystem
 * and is therefore atomic: a reader either sees the old config or the new one,
 * never a half-written file. A failed write removes its temp file rather than
 * leaving litter next to a config the user will look at.
 */
export async function updateConfig(
  pluginDir: string,
  patch: ConfigPatch,
): Promise<Record<string, unknown>> {
  const current = await readRawConfig(pluginDir);
  const merged: Record<string, unknown> = { ...current };

  if (patch.repoUrl !== undefined) {
    merged.repoUrl = validateRepoUrl(patch.repoUrl);
  }
  if (patch.branch !== undefined) {
    merged.branch = validateBranch(patch.branch);
  }
  if (patch.author !== undefined) {
    merged.author = validateAuthor(patch.author);
  }

  const target = configPath(pluginDir);
  const temp = `${target}.tmp.${process.pid}`;
  try {
    await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } catch {
    await unlink(temp).catch(() => {});
    throw new SetupConfigError(
      "CONFIG_UNWRITABLE",
      "The plugin's config.json could not be written.",
    );
  }
  return merged;
}
