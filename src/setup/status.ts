/**
 * Whether this install has finished setup, and which step it is stuck on.
 *
 * The app asks this on every load and shows the wizard until `complete` is
 * true, so the shape below is the contract for what "finished" means. Each step
 * is reported as done, blocked, or not yet reached, and carries the text the
 * wizard renders — keeping the reasoning here rather than in the app means the
 * two cannot disagree about what is wrong.
 *
 * Nothing in this module takes the sync lock, touches the network, or writes.
 * It is a read of state the other halves of the plugin already maintain.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { cloneDir, pathExists, readWatermark } from "../knowledge/base.js";
import { readRawConfig } from "./config-file.js";
import { hasStoredToken } from "./credential.js";
import { parseRemote, type RemoteTransport, toHttpsUrl } from "./remote.js";

export type StepState = "done" | "blocked" | "pending";

export interface SetupStep {
  id: "repository" | "access" | "identity" | "sync";
  state: StepState;
  /** One line naming what is missing, or what was found. Shown in the wizard. */
  detail: string;
}

export interface SetupStatus {
  /** True when the first three steps are done, which is when the app unlocks. */
  complete: boolean;
  steps: SetupStep[];
  repoUrl: string | null;
  branch: string;
  transport: RemoteTransport;
  /** `owner/repo`, when the URL carries one. Used to verify token access. */
  repoPath: string | null;
  /** Set only when an SSH remote could be offered as HTTPS instead. */
  httpsAlternative: string | null;
  author: { name: string; email: string } | null;
  tokenStored: boolean;
  clonePresent: boolean;
  syncedHead: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAuthor(config: Record<string, unknown>): { name: string; email: string } | null {
  const author = config.author;
  if (!isRecord(author)) {
    return null;
  }
  const { name, email } = author;
  if (typeof name !== "string" || typeof email !== "string") {
    return null;
  }
  if (name.trim().length === 0 || email.trim().length === 0) {
    return null;
  }
  return { name: name.trim(), email: email.trim() };
}

/**
 * The clone's own origin, which is the only evidence that SSH authentication
 * actually works on this machine. A clone directory exists only because a
 * `git clone` succeeded, so its presence for an SSH remote proves the key is
 * in place — the thing the wizard cannot otherwise determine.
 */
async function cloneOriginMatches(pluginDir: string, repoUrl: string): Promise<boolean> {
  try {
    const config = await readFile(join(cloneDir(pluginDir), ".git", "config"), "utf8");
    return config.includes(repoUrl);
  } catch {
    return false;
  }
}

function repositoryStep(repoUrl: string | null, transport: RemoteTransport): SetupStep {
  if (repoUrl === null) {
    return {
      id: "repository",
      state: "pending",
      detail: "Point the plugin at the git repository that holds your team's shared knowledge.",
    };
  }
  if (transport === "invalid") {
    return {
      id: "repository",
      state: "blocked",
      detail: "That repository URL is not usable. Use an https:// or git@ address.",
    };
  }
  return { id: "repository", state: "done", detail: repoUrl };
}

/**
 * The access step is the one that differs by transport.
 *
 * HTTPS authenticates with a token, which the wizard can collect and check, so
 * it is required and reported honestly as missing until it is stored. SSH
 * authenticates with a key the wizard can neither create nor inspect, so it is
 * judged by its result: a clone that exists is proof enough, and one that does
 * not is reported as blocked with the offer to switch to HTTPS instead.
 */
function accessStep(
  transport: RemoteTransport,
  tokenStored: boolean,
  sshProven: boolean,
  httpsAlternative: string | null,
): SetupStep {
  if (transport === "https") {
    return tokenStored
      ? { id: "access", state: "done", detail: "A GitHub token is stored for this repository." }
      : {
          id: "access",
          state: "pending",
          detail: "An https:// repository needs a GitHub token before the plugin can reach it.",
        };
  }
  if (transport === "ssh") {
    if (sshProven) {
      return {
        id: "access",
        state: "done",
        detail: "This install authenticates with an SSH key, which is already working.",
      };
    }
    return {
      id: "access",
      state: "blocked",
      detail: httpsAlternative
        ? "This SSH address needs a key set up on this machine and registered with GitHub. Switching to https:// lets setup finish here with a token instead."
        : "This SSH address needs a key set up on this machine and registered with GitHub.",
    };
  }
  if (transport === "other") {
    // A file://, git:// or local-path remote needs nothing from the vault, and
    // the plugin cannot check it ahead of time. Standing aside is right: the
    // alternative is holding a working install at a step with no action on it.
    return {
      id: "access",
      state: "done",
      detail: "This address needs no credential from the plugin. The first sync will show whether it works.",
    };
  }
  return { id: "access", state: "pending", detail: "Set a repository URL first." };
}

export async function readSetupStatus(pluginDir: string): Promise<SetupStatus> {
  const config = await readRawConfig(pluginDir);

  const rawUrl = typeof config.repoUrl === "string" ? config.repoUrl.trim() : "";
  const repoUrl = rawUrl.length > 0 ? rawUrl : null;
  const branch =
    typeof config.branch === "string" && config.branch.trim().length > 0
      ? config.branch.trim()
      : "main";

  const remote = repoUrl === null ? null : parseRemote(repoUrl);
  // No URL yet reads as invalid, which is what the repository step reports on.
  const transport: RemoteTransport = remote?.transport ?? "invalid";
  const author = readAuthor(config);

  const clonePresent = await pathExists(join(cloneDir(pluginDir), ".git"));
  const syncedHead = await readWatermark(pluginDir, "last-sha");
  const tokenStored = transport === "https" ? await hasStoredToken() : false;
  const sshProven =
    transport === "ssh" && repoUrl !== null && clonePresent
      ? await cloneOriginMatches(pluginDir, repoUrl)
      : false;

  const httpsAlternative =
    transport === "ssh" && repoUrl !== null ? toHttpsUrl(repoUrl) : null;

  const repository = repositoryStep(repoUrl, transport);
  const access = accessStep(transport, tokenStored, sshProven, httpsAlternative);

  const identity: SetupStep =
    author === null
      ? {
          id: "identity",
          state: "pending",
          // The sync schedule fills this from the guardian contact when it can,
          // so the wizard offers rather than demands, and says why it matters.
          detail:
            "Commits need an author. Without one the plugin can still read shared knowledge but cannot publish.",
        }
      : { id: "identity", state: "done", detail: `${author.name} <${author.email}>` };

  const sync: SetupStep =
    syncedHead !== null
      ? { id: "sync", state: "done", detail: `Synced at ${syncedHead.slice(0, 7)}.` }
      : clonePresent
        ? { id: "sync", state: "pending", detail: "The repository is cloned but has not synced yet." }
        : { id: "sync", state: "pending", detail: "Nothing has been synced yet." };

  const steps = [repository, access, identity, sync];

  return {
    // The sync step is excluded on purpose: it is work the schedule does on its
    // own once the first three are satisfied, so blocking the app on it would
    // hold the user at a screen they cannot act on.
    complete: repository.state === "done" && access.state === "done" && identity.state === "done",
    steps,
    repoUrl,
    branch,
    transport,
    repoPath: remote?.repoPath ?? null,
    httpsAlternative,
    author,
    tokenStored,
    clonePresent,
    syncedHead,
  };
}
