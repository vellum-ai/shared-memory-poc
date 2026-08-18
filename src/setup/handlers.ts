/**
 * Request handling for the setup flow's routes.
 *
 * The route files under `routes/setup/` stay one-liners; the work is here so it
 * can be tested without a running daemon. Responses use the same
 * `{ok: true, ...}` / `{ok: false, error: {code, message}}` envelope the
 * knowledge routes use, because the app's `request` helper unwraps that shape
 * for every call it makes.
 */

import { join } from "node:path";

import { errorResponse, jsonResponse } from "../knowledge/base.js";
import { type ConfigAuthor, SetupConfigError, updateConfig } from "./config-file.js";
import { readStoredToken, SetupCredentialError, storeToken, verifyToken } from "./credential.js";
import { readSetupStatus } from "./status.js";

/** A first clone is the slow case; past that a sync is seconds. */
const SYNC_TIMEOUT_MS = 120_000;
const MAX_SYNC_OUTPUT_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every handler ends here. `SetupConfigError` and `SetupCredentialError` carry
 * a message written for the person in the wizard, so they are passed through;
 * anything else is reported generically rather than leaking an internal string
 * into the UI.
 */
function failure(error: unknown): Response {
  if (error instanceof SetupConfigError) {
    return errorResponse(400, error.code, error.message);
  }
  if (error instanceof SetupCredentialError) {
    return errorResponse(400, error.code, error.message);
  }
  return errorResponse(500, "SETUP_ERROR", "The setup step could not be completed.");
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new SetupConfigError("INVALID_BODY", "The request body must be JSON.");
  }
  if (!isRecord(body)) {
    throw new SetupConfigError("INVALID_BODY", "The request body must be a JSON object.");
  }
  return body;
}

export async function handleSetupStatus(pluginDir: string): Promise<Response> {
  try {
    return jsonResponse({ ok: true, status: await readSetupStatus(pluginDir) });
  } catch (error) {
    return failure(error);
  }
}

function readAuthorInput(value: unknown): ConfigAuthor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new SetupConfigError("INVALID_AUTHOR", "The author must be a name and an email.");
  }
  const { name, email } = value;
  if (typeof name !== "string" || typeof email !== "string") {
    throw new SetupConfigError("INVALID_AUTHOR", "The author must be a name and an email.");
  }
  return { name, email };
}

export async function handleSetupConfig(request: Request, pluginDir: string): Promise<Response> {
  try {
    const body = await readJsonBody(request);

    const repoUrl = body.repoUrl;
    const branch = body.branch;
    if (repoUrl !== undefined && typeof repoUrl !== "string") {
      throw new SetupConfigError("INVALID_REPO_URL", "The repository URL must be a string.");
    }
    if (branch !== undefined && typeof branch !== "string") {
      throw new SetupConfigError("INVALID_BRANCH", "The branch must be a string.");
    }

    const author = readAuthorInput(body.author);

    // Each key is omitted rather than passed as undefined, so a step that only
    // sets the author cannot blank out a repoUrl the user already saved.
    await updateConfig(pluginDir, {
      ...(repoUrl === undefined ? {} : { repoUrl }),
      ...(branch === undefined ? {} : { branch }),
      ...(author === undefined ? {} : { author }),
    });

    // The fresh status is returned rather than left to a follow-up request so
    // the wizard advances from one round trip and cannot render a step it has
    // already satisfied.
    return jsonResponse({ ok: true, status: await readSetupStatus(pluginDir) });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Store the GitHub token, then check it against the configured repository.
 *
 * Storing and verifying are reported separately on purpose. A token that stores
 * but fails its check is still stored — re-prompting for it would lose a value
 * the user has already pasted, and the failure is usually the repository URL
 * rather than the token. So the response says the token was saved and names
 * what did not work.
 */
export async function handleSetupCredential(
  request: Request,
  pluginDir: string,
): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    await storeToken(body.token);

    const status = await readSetupStatus(pluginDir);
    if (status.repoPath === null) {
      return jsonResponse({
        ok: true,
        stored: true,
        verified: false,
        message:
          "The token was saved. Set a GitHub repository URL and the next sync will check it.",
        status,
      });
    }

    const token = await readStoredToken();
    if (token === null) {
      return errorResponse(
        500,
        "CREDENTIAL_UNREADABLE",
        "The token was saved but could not be read back to check it.",
      );
    }

    const outcome = await verifyToken(token, status.repoPath);
    if (!outcome.ok) {
      return jsonResponse({
        ok: true,
        stored: true,
        verified: false,
        code: outcome.code,
        message: outcome.message,
        status,
      });
    }

    return jsonResponse({
      ok: true,
      stored: true,
      verified: true,
      canPush: outcome.canPush,
      message: outcome.canPush
        ? `The token works and can publish to ${outcome.repoPath}.`
        : `The token can read ${outcome.repoPath}, but cannot publish to it. Shared knowledge will sync in, and publishing will fail until the token grants Contents write.`,
      status,
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Run one sync now, rather than waiting for the schedule's next tick.
 *
 * The script holds its own lock, so a run started here and a scheduled run
 * cannot collide. Output is captured and the tail returned on failure: the
 * whole point of running it from the wizard is that the user sees whether their
 * repository and token actually work, and a bare "it failed" would send them
 * back to guess which step was wrong.
 */
export async function handleSetupSync(pluginDir: string): Promise<Response> {
  const script = join(pluginDir, "schedules", "sync", "index.sh");
  try {
    const proc = Bun.spawn([script], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: SYNC_TIMEOUT_MS,
      killSignal: "SIGTERM",
      maxBuffer: MAX_SYNC_OUTPUT_BYTES,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const status = await readSetupStatus(pluginDir);
    if (exitCode === 0) {
      return jsonResponse({ ok: true, synced: true, status });
    }
    return jsonResponse({
      ok: true,
      synced: false,
      // The script's own messages are the useful diagnostic here, and it is
      // careful not to print secrets. The tail is bounded so a runaway log
      // cannot become the response body.
      message: `${stdout}\n${stderr}`.trim().slice(-2_000),
      status,
    });
  } catch {
    return errorResponse(
      503,
      "SYNC_FAILED",
      "The sync could not be started. The schedule will try again on its next tick.",
    );
  }
}
