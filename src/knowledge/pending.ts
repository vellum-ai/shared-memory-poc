import { join } from "node:path";

import {
  failureResponse,
  jsonResponse,
  KnowledgeError,
  requireBase,
  searchParams,
} from "./base.js";

const COLLECT_TIMEOUT_MS = 30_000;
const COLLECT_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_CHARS = 400;

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

function collectFailed(reason: string, stderr: string): KnowledgeError {
  const detail = tail(stderr);
  return new KnowledgeError(
    503,
    "COLLECT_FAILED",
    detail.length === 0 ? reason : `${reason} ${detail}`,
  );
}

/**
 * Runs the digest schedule's own collector, so the dashboard and the next
 * notification report the same facts. The statuses it prints, including
 * no-sync, baselined and no-changes, are passed through as it wrote them.
 *
 * The collector needs git and jq on PATH. It writes nothing but the digest
 * watermark, and only on the run that baselines a fresh install.
 */
export async function collectPendingDigest(pluginDir: string): Promise<unknown> {
  const script = join(pluginDir, "schedules", "digest", "index.sh");
  const proc = Bun.spawn(["bash", script, "--collect"], {
    cwd: pluginDir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: COLLECT_TIMEOUT_MS,
    killSignal: "SIGTERM",
    maxBuffer: COLLECT_OUTPUT_BYTES,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw collectFailed(`The digest collector exited with code ${exitCode}.`, stderr);
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw collectFailed("The digest collector did not print JSON.", stderr);
  }
}

export async function handleKnowledgePending(
  request: Request,
  pluginDir: string,
): Promise<Response> {
  try {
    const base = requireBase(searchParams(request));
    return jsonResponse({ ok: true, base, digest: await collectPendingDigest(pluginDir) });
  } catch (error) {
    return failureResponse(error);
  }
}
