import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_CONCEPT_FILE_BYTES,
  MAX_EXACT_PATHS,
  validateConceptPath,
} from "./concept-path.js";
import {
  createEffectivePolicy,
  createOperationSignal,
  createPolicyFingerprint,
  type EffectivePolicy,
  findConceptTreeEntry,
  MAX_EXACT_CONTENT_BYTES,
  readRepositoryConfig,
  type RepositoryRevision,
  runRepositoryGit,
  SharedMemoryRepositoryError,
  withRepositoryRevision,
} from "./shared-memory-repository.js";

export const MAX_COMMIT_MESSAGE_BYTES = 120;
export const GIT_OBJECT_ID_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";

const PUSH_FOLLOWUP_TIMEOUT_MS = 30_000;
const GIT_OBJECT_ID = new RegExp(GIT_OBJECT_ID_PATTERN);

export interface SharedMemoryUpsert {
  path: string;
  content: string;
}

export interface SharedMemoryPublishProposal {
  expectedHead: string;
  expectedPolicyFingerprint: string;
  commitMessage: string;
  upserts: SharedMemoryUpsert[];
}

export interface SharedMemoryPublishResult {
  branch: string;
  previousHead: string;
  effectivePolicy: EffectivePolicy;
  policyFingerprint: string;
  changedPaths: string[];
  noop: boolean;
  commitSha?: string;
  commitUrl?: string;
  checkoutUpdated?: boolean;
}

interface PublishErrorDetails {
  effectivePolicy?: EffectivePolicy;
  observedHead?: string;
  commitSha?: string;
}

interface ChangedUpsert extends SharedMemoryUpsert {
  mode: "100644" | "100755";
}

const COMMITTER_IDENTITY = {
  GIT_COMMITTER_NAME: "Vellum Assistant",
  GIT_COMMITTER_EMAIL: "assistant@vellum.ai",
};

export class SharedMemoryPublishError extends Error {
  readonly effectivePolicy?: EffectivePolicy;
  readonly observedHead?: string;
  readonly commitSha?: string;

  constructor(
    readonly code: string,
    message: string,
    details: PublishErrorDetails = {},
  ) {
    super(message);
    this.name = "SharedMemoryPublishError";
    this.effectivePolicy = details.effectivePolicy;
    this.observedHead = details.observedHead;
    this.commitSha = details.commitSha;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function parsePublishProposal(input: Record<string, unknown>): SharedMemoryPublishProposal {
  if (
    !exactKeys(input, [
      "commitMessage",
      "expectedHead",
      "expectedPolicyFingerprint",
      "upserts",
    ])
  ) {
    throw new SharedMemoryPublishError(
      "INVALID_INPUT",
      "Provide only expectedHead, expectedPolicyFingerprint, commitMessage, and upserts.",
    );
  }
  if (typeof input.expectedHead !== "string" || !GIT_OBJECT_ID.test(input.expectedHead)) {
    throw new SharedMemoryPublishError(
      "INVALID_INPUT",
      "expectedHead must be the complete commit object ID from shared_memory_inspect.",
    );
  }
  if (
    typeof input.expectedPolicyFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.expectedPolicyFingerprint)
  ) {
    throw new SharedMemoryPublishError(
      "INVALID_INPUT",
      "expectedPolicyFingerprint must be the fingerprint from shared_memory_inspect.",
    );
  }
  if (typeof input.commitMessage !== "string") {
    throw new SharedMemoryPublishError("INVALID_INPUT", "commitMessage must be a string.");
  }
  const commitMessage = input.commitMessage.trim();
  if (
    commitMessage.length === 0 ||
    byteLength(commitMessage) > MAX_COMMIT_MESSAGE_BYTES ||
    /[\0-\x1f\x7f]/.test(commitMessage)
  ) {
    throw new SharedMemoryPublishError(
      "INVALID_INPUT",
      `commitMessage must be one line of at most ${MAX_COMMIT_MESSAGE_BYTES} UTF-8 bytes.`,
    );
  }
  if (!Array.isArray(input.upserts) || input.upserts.length === 0 || input.upserts.length > MAX_EXACT_PATHS) {
    throw new SharedMemoryPublishError(
      "INVALID_INPUT",
      `Provide between 1 and ${MAX_EXACT_PATHS} Markdown upserts.`,
    );
  }

  let totalBytes = 0;
  const upserts = input.upserts.map((value): SharedMemoryUpsert => {
    if (!isRecord(value) || !exactKeys(value, ["content", "path"])) {
      throw new SharedMemoryPublishError(
        "INVALID_INPUT",
        "Each upsert must contain only path and complete Markdown content.",
      );
    }
    const path = validateConceptPath(value.path);
    if (typeof value.content !== "string" || value.content.trim().length === 0) {
      throw new SharedMemoryPublishError(
        "INVALID_INPUT",
        `${path} must contain non-empty Markdown.`,
      );
    }
    const size = byteLength(value.content);
    if (value.content.includes("\0") || size > MAX_CONCEPT_FILE_BYTES) {
      throw new SharedMemoryPublishError(
        "CONTENT_LIMIT",
        `${path} exceeds the ${MAX_CONCEPT_FILE_BYTES}-byte publishing limit or is not text.`,
      );
    }
    totalBytes += size;
    return { path, content: value.content };
  });
  if (new Set(upserts.map(({ path }) => path)).size !== upserts.length) {
    throw new SharedMemoryPublishError("PATH_ERROR", "Published concept paths must be unique.");
  }
  if (totalBytes > MAX_EXACT_CONTENT_BYTES) {
    throw new SharedMemoryPublishError(
      "CONTENT_LIMIT",
      `One publication may contain at most ${MAX_EXACT_CONTENT_BYTES} UTF-8 bytes.`,
    );
  }

  return {
    expectedHead: input.expectedHead,
    expectedPolicyFingerprint: input.expectedPolicyFingerprint,
    commitMessage,
    upserts: upserts.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function outputText(value: Buffer): string {
  return value.toString("utf8").trim();
}

async function resolveCommitIdentity(
  repoDir: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const readConfig = (key: string) =>
    runRepositoryGit(repoDir, ["config", "--get", key], {
      signal,
      allowedExitCodes: [0, 1],
    });
  const [authorNameResult, authorEmailResult, userNameResult, userEmailResult] =
    await Promise.all([
      readConfig("author.name"),
      readConfig("author.email"),
      readConfig("user.name"),
      readConfig("user.email"),
    ]);
  const nameResult = authorNameResult.exitCode === 0 ? authorNameResult : userNameResult;
  const emailResult = authorEmailResult.exitCode === 0 ? authorEmailResult : userEmailResult;
  const name = outputText(nameResult.stdout);
  const email = outputText(emailResult.stdout);
  if (
    nameResult.exitCode !== 0 ||
    emailResult.exitCode !== 0 ||
    name.length === 0 ||
    email.length === 0 ||
    /[\0-\x1f\x7f]/.test(name) ||
    /[\0-\x1f\x7f]/.test(email)
  ) {
    throw new SharedMemoryPublishError(
      "GIT_IDENTITY_MISSING",
      "Configure a Git author name and email for the shared-memory repository before publishing.",
    );
  }
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    ...COMMITTER_IDENTITY,
  };
}

async function assertRepositoryReady(
  revision: RepositoryRevision,
  signal?: AbortSignal,
): Promise<void> {
  const pushUrls = outputText(
    (
      await runRepositoryGit(
        revision.repoDir,
        ["remote", "get-url", "--push", "--all", "origin"],
        { signal },
      )
    ).stdout,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  if (pushUrls.length !== 1 || pushUrls[0] !== revision.repoUrl) {
    throw new SharedMemoryPublishError(
      "REPOSITORY_MISMATCH",
      "The local shared-memory clone push origin does not match config.json.",
    );
  }

  const status = await runRepositoryGit(
    revision.repoDir,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { signal },
  );
  if (status.stdout.length > 0) {
    throw new SharedMemoryPublishError("REPOSITORY_DIRTY", "The shared-memory checkout has local changes.");
  }

  const stash = await runRepositoryGit(revision.repoDir, ["stash", "list", "--format=%gd"], {
    signal,
  });
  if (stash.stdout.length > 0) {
    throw new SharedMemoryPublishError("REPOSITORY_DIRTY", "The shared-memory checkout has a stash.");
  }

  const localOnly = await runRepositoryGit(
    revision.repoDir,
    ["log", "--branches", "--not", "--remotes", "--format=%H"],
    { signal },
  );
  if (localOnly.stdout.length > 0) {
    throw new SharedMemoryPublishError(
      "REPOSITORY_DIRTY",
      "The shared-memory checkout has unpushed local commits.",
    );
  }

  const rebase = await runRepositoryGit(
    revision.repoDir,
    ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"],
    { signal, allowedExitCodes: [0, 1] },
  );
  if (rebase.exitCode === 0) {
    throw new SharedMemoryPublishError("REPOSITORY_DIRTY", "The shared-memory checkout has a rebase in progress.");
  }

  const ancestor = await runRepositoryGit(
    revision.repoDir,
    ["merge-base", "--is-ancestor", "HEAD", revision.expectedHead],
    { signal, allowedExitCodes: [0, 1] },
  );
  if (ancestor.exitCode !== 0) {
    throw new SharedMemoryPublishError(
      "REPOSITORY_DIRTY",
      "The checked-out branch is not an ancestor of the inspected remote head.",
    );
  }
}

async function changedUpserts(
  revision: RepositoryRevision,
  upserts: SharedMemoryUpsert[],
  signal?: AbortSignal,
): Promise<ChangedUpsert[]> {
  const changed: ChangedUpsert[] = [];
  for (const upsert of upserts) {
    const entry = await findConceptTreeEntry(revision, upsert.path, signal);
    const proposedOid = outputText(
      (
        await runRepositoryGit(revision.repoDir, ["hash-object", "--stdin"], {
          signal,
          stdin: upsert.content,
        })
      ).stdout,
    );
    if (entry?.oid !== proposedOid) {
      changed.push({ ...upsert, mode: entry?.mode ?? "100644" });
    }
  }
  return changed;
}

async function fetchRemoteHead(
  revision: RepositoryRevision,
  signal?: AbortSignal,
): Promise<string> {
  await runRepositoryGit(
    revision.repoDir,
    ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${revision.branch}`],
    { signal },
  );
  return outputText(
    (
      await runRepositoryGit(
        revision.repoDir,
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        { signal },
      )
    ).stdout,
  );
}

function requireExpectedHead(
  expectedHead: string,
  observedHead: string,
  effectivePolicy: EffectivePolicy,
): void {
  if (observedHead !== expectedHead) {
    throw new SharedMemoryPublishError(
      "STALE_HEAD",
      "Shared memory changed after inspection. Inspect the new head and reconsolidate before publishing.",
      { effectivePolicy, observedHead },
    );
  }
}

function requireExpectedPolicy(
  expectedPolicyFingerprint: string,
  revision: RepositoryRevision,
): void {
  if (revision.policyFingerprint !== expectedPolicyFingerprint) {
    throw new SharedMemoryPublishError(
      "STALE_POLICY",
      "Shared-memory sharing guidance changed after inspection. Inspect again before publishing.",
      { effectivePolicy: revision.effectivePolicy },
    );
  }
}

async function requireCurrentConfiguration(
  expectedPolicyFingerprint: string,
  revision: RepositoryRevision,
  pluginDir: string,
): Promise<void> {
  const config = await readRepositoryConfig(pluginDir);
  const effectivePolicy = createEffectivePolicy(config.sharingGuidance);
  if (config.repoUrl !== revision.repoUrl || config.branch !== revision.branch) {
    throw new SharedMemoryPublishError(
      "REPOSITORY_MISMATCH",
      "The shared-memory repository target changed after inspection. Inspect again before publishing.",
      { effectivePolicy },
    );
  }
  if (createPolicyFingerprint(effectivePolicy) !== expectedPolicyFingerprint) {
    throw new SharedMemoryPublishError(
      "STALE_POLICY",
      "Shared-memory sharing guidance changed after inspection. Inspect again before publishing.",
      { effectivePolicy },
    );
  }
}

async function createCommit(
  revision: RepositoryRevision,
  proposal: SharedMemoryPublishProposal,
  changed: ChangedUpsert[],
  pluginDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const indexPath = join(pluginDir, "data", `publish-index.${randomUUID()}`);
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    const commitIdentity = await resolveCommitIdentity(revision.repoDir, signal);
    await runRepositoryGit(revision.repoDir, ["read-tree", proposal.expectedHead], {
      signal,
      env: indexEnv,
    });
    for (const upsert of changed) {
      const blobOid = outputText(
        (
          await runRepositoryGit(revision.repoDir, ["hash-object", "-w", "--stdin"], {
            signal,
            stdin: upsert.content,
          })
        ).stdout,
      );
      await runRepositoryGit(
        revision.repoDir,
        ["update-index", "--add", "--cacheinfo", upsert.mode, blobOid, upsert.path],
        { signal, env: indexEnv },
      );
    }

    const diff = await runRepositoryGit(
      revision.repoDir,
      ["diff-index", "--cached", "--name-only", "-z", proposal.expectedHead, "--"],
      { signal, env: indexEnv },
    );
    const stagedPaths = diff.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const expectedPaths = changed.map(({ path }) => path).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) {
      throw new SharedMemoryPublishError(
        "REPOSITORY_ERROR",
        "The proposed Git tree changed paths outside the validated publication.",
      );
    }

    const tree = outputText(
      (
        await runRepositoryGit(revision.repoDir, ["write-tree"], {
          signal,
          env: indexEnv,
        })
      ).stdout,
    );
    return outputText(
      (
        await runRepositoryGit(
          revision.repoDir,
          ["commit-tree", tree, "-p", proposal.expectedHead],
          {
            signal,
            stdin: `${proposal.commitMessage}\n`,
            env: { ...indexEnv, ...commitIdentity },
          },
        )
      ).stdout,
    );
  } finally {
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
  }
}

async function isAncestor(
  repoDir: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runRepositoryGit(
    repoDir,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { signal, allowedExitCodes: [0, 1] },
  );
  return result.exitCode === 0;
}

async function verifyPushOutcome(
  revision: RepositoryRevision,
  commitSha: string,
): Promise<{ remoteHead: string; containsCommit: boolean }> {
  const deadline = createOperationSignal(undefined, PUSH_FOLLOWUP_TIMEOUT_MS);
  try {
    const remoteHead = await fetchRemoteHead(revision, deadline.signal);
    return {
      remoteHead,
      containsCommit: await isAncestor(
        revision.repoDir,
        commitSha,
        remoteHead,
        deadline.signal,
      ),
    };
  } catch {
    throw new SharedMemoryPublishError(
      "PUSH_UNKNOWN",
      "The push result could not be verified. Inspect the repository before retrying.",
      { effectivePolicy: revision.effectivePolicy, commitSha },
    );
  } finally {
    deadline.dispose();
  }
}

async function updateCheckoutAfterPush(
  revision: RepositoryRevision,
  remoteHead: string,
): Promise<boolean> {
  const deadline = createOperationSignal(undefined, PUSH_FOLLOWUP_TIMEOUT_MS);
  try {
    const checkout = await runRepositoryGit(
      revision.repoDir,
      ["merge", "--ff-only", "--quiet", remoteHead],
      { signal: deadline.signal, allowFailure: true },
    );
    return checkout.exitCode === 0;
  } catch {
    return false;
  } finally {
    deadline.dispose();
  }
}

function githubCommitUrl(repoUrl: string, commitSha: string): string | undefined {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repoUrl);
  if (scp) {
    return `https://github.com/${scp[1]}/${scp[2]}/commit/${commitSha}`;
  }
  try {
    const parsed = new URL(repoUrl);
    const hasUnsafeCredentials =
      (parsed.protocol === "https:" && Boolean(parsed.username || parsed.password)) ||
      (parsed.protocol === "ssh:" && Boolean(parsed.password || (parsed.username && parsed.username !== "git")));
    if (
      parsed.hostname.toLowerCase() !== "github.com" ||
      hasUnsafeCredentials ||
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
    ) {
      return undefined;
    }
    const parts = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
      return undefined;
    }
    return `https://github.com/${parts[0]}/${parts[1]}/commit/${commitSha}`;
  } catch {
    return undefined;
  }
}

async function publishAtRevision(
  revision: RepositoryRevision,
  proposal: SharedMemoryPublishProposal,
  pluginDir: string,
  signal?: AbortSignal,
): Promise<SharedMemoryPublishResult> {
  requireExpectedPolicy(proposal.expectedPolicyFingerprint, revision);
  requireExpectedHead(proposal.expectedHead, revision.expectedHead, revision.effectivePolicy);
  await assertRepositoryReady(revision, signal);
  const changed = await changedUpserts(revision, proposal.upserts, signal);
  const freshHead = await fetchRemoteHead(revision, signal);
  requireExpectedHead(proposal.expectedHead, freshHead, revision.effectivePolicy);
  if (changed.length === 0) {
    await requireCurrentConfiguration(
      proposal.expectedPolicyFingerprint,
      revision,
      pluginDir,
    );
    return {
      branch: revision.branch,
      previousHead: proposal.expectedHead,
      effectivePolicy: revision.effectivePolicy,
      policyFingerprint: revision.policyFingerprint,
      changedPaths: [],
      noop: true,
    };
  }

  const commitSha = await createCommit(revision, proposal, changed, pluginDir, signal);
  await requireCurrentConfiguration(
    proposal.expectedPolicyFingerprint,
    revision,
    pluginDir,
  );
  let pushExitCode: number | undefined;
  let pushUncertain = false;
  try {
    const push = await runRepositoryGit(
      revision.repoDir,
      ["push", "--porcelain", "origin", `${commitSha}:refs/heads/${revision.branch}`],
      { signal, allowFailure: true },
    );
    pushExitCode = push.exitCode;
  } catch (error) {
    if (!(error instanceof SharedMemoryRepositoryError)) {
      throw error;
    }
    pushUncertain = true;
  }

  let remoteHead = commitSha;
  if (pushUncertain || pushExitCode !== 0) {
    const verification = await verifyPushOutcome(revision, commitSha);
    remoteHead = verification.remoteHead;
    if (!verification.containsCommit) {
      if (pushUncertain) {
        throw new SharedMemoryPublishError(
          "PUSH_UNKNOWN",
          "The push result could not be verified. Inspect the repository before retrying.",
          {
            effectivePolicy: revision.effectivePolicy,
            observedHead: remoteHead,
            commitSha,
          },
        );
      }
      if (remoteHead !== proposal.expectedHead) {
        throw new SharedMemoryPublishError(
          "STALE_HEAD",
          "Another writer published first. Inspect the new head and reconsolidate before retrying.",
          { effectivePolicy: revision.effectivePolicy, observedHead: remoteHead, commitSha },
        );
      }
      throw new SharedMemoryPublishError(
        "PUSH_FAILED",
        "The remote rejected the publication. Inspect the repository before retrying.",
        { effectivePolicy: revision.effectivePolicy, observedHead: remoteHead, commitSha },
      );
    }
  }

  const checkoutUpdated = await updateCheckoutAfterPush(revision, remoteHead);
  const result: SharedMemoryPublishResult = {
    branch: revision.branch,
    previousHead: proposal.expectedHead,
    effectivePolicy: revision.effectivePolicy,
    policyFingerprint: revision.policyFingerprint,
    changedPaths: changed.map(({ path }) => path),
    noop: false,
    commitSha,
    checkoutUpdated,
  };
  const commitUrl = githubCommitUrl(revision.repoUrl, commitSha);
  if (commitUrl) {
    result.commitUrl = commitUrl;
  }
  return result;
}

export async function publishSharedMemory(
  proposal: SharedMemoryPublishProposal,
  pluginDir: string,
  signal?: AbortSignal,
): Promise<SharedMemoryPublishResult> {
  let effectivePolicy: EffectivePolicy | undefined;
  try {
    return await withRepositoryRevision(pluginDir, signal, async (revision) => {
      effectivePolicy = revision.effectivePolicy;
      return publishAtRevision(revision, proposal, pluginDir, signal);
    });
  } catch (error) {
    if (error instanceof SharedMemoryPublishError) {
      if (error.effectivePolicy || !effectivePolicy) {
        throw error;
      }
      throw new SharedMemoryPublishError(error.code, error.message, {
        effectivePolicy,
        observedHead: error.observedHead,
        commitSha: error.commitSha,
      });
    }
    if (error instanceof SharedMemoryRepositoryError) {
      throw new SharedMemoryPublishError(error.code, error.message, { effectivePolicy });
    }
    throw error;
  }
}
