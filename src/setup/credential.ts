/**
 * The GitHub token the plugin authenticates its clone, fetch and push with.
 *
 * The value lives in the assistant's encrypted credential vault, never in
 * `config.json` and never on the plugin's own disk. `storeCredential` and
 * `resolveCredential` both scope a plugin to credentials whose `field` equals
 * its manifest name, so `github/shared-memory` is the only reference this
 * plugin can use — and the only one it can reach, which is what keeps it away
 * from the user's own `github/token`.
 *
 * Nothing here logs a token, returns one to the app, or puts one in an error
 * message. The verify path deliberately reports a category rather than
 * GitHub's response body, because that body echoes request details.
 */

import { HostTooOldError, readCredential, writeCredential } from "./host-credentials.js";

/**
 * Where the token lives in the vault.
 *
 * The field half must stay equal to the plugin's manifest name: the host scopes
 * both the read and the write by comparing the field against it, so renaming
 * the plugin without renaming this breaks both. `bin/git-askpass.sh` names the
 * same pair for git's benefit and has to be changed alongside it.
 */
export const CREDENTIAL_REF = "github/shared-memory";

const GITHUB_API = "https://api.github.com";
const VERIFY_TIMEOUT_MS = 15_000;

/** A token that cannot be a GitHub PAT is refused before it reaches the vault. */
const MAX_TOKEN_BYTES = 1_024;

export class SetupCredentialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SetupCredentialError";
  }
}

/**
 * Whether a token is stored, without reading its value.
 *
 * A resolution failure is reported as "absent" rather than propagated: the only
 * caller is the status route, and every failure mode it can hit — no such
 * credential, store unreachable — means the same thing to the setup flow, which
 * is that the access step is not finished.
 */
export async function hasStoredToken(): Promise<boolean> {
  const value = await readCredential(CREDENTIAL_REF);
  return value !== null && value.length > 0;
}

/** The stored token, or null when none is stored. */
export async function readStoredToken(): Promise<string | null> {
  return readCredential(CREDENTIAL_REF);
}

function normalizeToken(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SetupCredentialError("INVALID_TOKEN", "A token is required.");
  }
  const token = raw.trim();
  if (token.length === 0) {
    throw new SetupCredentialError("INVALID_TOKEN", "A token is required.");
  }
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new SetupCredentialError("INVALID_TOKEN", "That value is too long to be a GitHub token.");
  }
  // A token reaches git through an askpass helper, which is line-oriented, so
  // an embedded newline would truncate it into a value that fails to
  // authenticate for reasons no error message would explain.
  if (/[\s\0]/.test(token)) {
    throw new SetupCredentialError(
      "INVALID_TOKEN",
      "A GitHub token contains no spaces or line breaks. Check for a partial copy.",
    );
  }
  return token;
}

/**
 * Persist the token.
 *
 * The transcript scrub is left on. The token arrives from the setup screen and
 * so has not passed through a conversation, but leaving the sweep enabled costs
 * one bounded pass over recent history and covers the case where the user
 * pasted it into chat first and then into the form.
 */
export async function storeToken(raw: unknown): Promise<void> {
  const token = normalizeToken(raw);
  try {
    await writeCredential(CREDENTIAL_REF, token, {
      label: "Shared memory GitHub access",
      description:
        "Clones, fetches and pushes the team's shared knowledge repository for the shared-memory plugin.",
    });
  } catch (error) {
    // An old host is the one failure with an action attached, so its message is
    // carried through to the wizard rather than flattened into a generic 500.
    if (error instanceof HostTooOldError) {
      throw new SetupCredentialError("UNSUPPORTED_HOST", error.message);
    }
    throw error;
  }
}

export type VerifyOutcome =
  | { ok: true; repoPath: string; canPush: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "NO_ACCESS" | "NOT_FOUND" | "UNREACHABLE"; message: string };

/**
 * Check the token against the configured repository.
 *
 * This is the difference between "a token is stored" and "setup works". A token
 * with the wrong scopes, or one that cannot see this particular repository,
 * stores perfectly well and then fails on the first sync with a git error the
 * user has no way to connect back to the token they just pasted.
 *
 * Push access is reported rather than required: reading the shared repo is
 * enough to use the plugin, and only publishing needs write.
 */
export async function verifyToken(token: string, repoPath: string): Promise<VerifyOutcome> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${repoPath}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "vellum-shared-memory-plugin",
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      code: "UNREACHABLE",
      message: "GitHub could not be reached to check the token. The token was saved.",
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "GitHub rejected the token. Check that it was copied whole and has not expired.",
    };
  }
  // GitHub answers 404 rather than 403 for a repository a token cannot see, so
  // a private repo the token lacks scope for is indistinguishable from a typo
  // in the URL. The message names both rather than guessing.
  if (response.status === 403 || response.status === 404) {
    return {
      ok: false,
      code: "NO_ACCESS",
      message: `The token cannot see ${repoPath}. Check the repository URL, and that the token grants access to this repository with Contents read and write.`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "UNREACHABLE",
      message: "GitHub returned an unexpected response. The token was saved.",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      code: "UNREACHABLE",
      message: "GitHub returned a response that could not be read. The token was saved.",
    };
  }

  const permissions =
    typeof body === "object" && body !== null && "permissions" in body
      ? (body as { permissions?: unknown }).permissions
      : undefined;
  const canPush =
    typeof permissions === "object" &&
    permissions !== null &&
    (permissions as { push?: unknown }).push === true;

  return { ok: true, repoPath, canPush };
}
