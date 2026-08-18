/**
 * Classify the configured `repoUrl` by how git will authenticate against it.
 *
 * The two transports need different things from the user, and the setup flow
 * can only finish one of them on its own:
 *
 * - **HTTPS** (`https://github.com/org/repo.git`) authenticates with a username
 *   and a token. The wizard collects that token, stores it, and verifies it, so
 *   an install can go from nothing to syncing without leaving the app.
 * - **SSH** (`git@github.com:org/repo.git`) authenticates with a key that lives
 *   on the machine and is registered with the host. Nothing in the app can
 *   create that key, so the wizard cannot walk a user through it — it can only
 *   report whether the clone works.
 *
 * So the flow guides HTTPS, and leaves a working SSH install alone rather than
 * pushing a token at someone whose setup already authenticates.
 */

/** How git will authenticate to the remote. */
export type RemoteTransport = "https" | "ssh" | "unknown";

export interface ParsedRemote {
  transport: RemoteTransport;
  /** Host, lowercased, or null when the URL did not parse. */
  host: string | null;
  /** `owner/repo` with any `.git` suffix removed, or null when not derivable. */
  repoPath: string | null;
  /** True when the remote is GitHub, which is the only host the wizard guides. */
  isGitHub: boolean;
}

const UNPARSED: ParsedRemote = {
  transport: "unknown",
  host: null,
  repoPath: null,
  isGitHub: false,
};

/**
 * `user@host:path` — git's scp-like syntax, which is SSH despite carrying no
 * scheme. The host part excludes `/` so a real URL never matches here.
 */
const SCP_LIKE = /^([^@/]+)@([^:/]+):(.+)$/;

const MAX_URL_BYTES = 2_048;

function stripGitSuffix(path: string): string {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
}

/**
 * A repo path is only useful to the wizard when it names an owner and a repo,
 * which is what the GitHub API calls need. Anything deeper or shallower is
 * reported as absent rather than guessed at.
 */
function ownerRepo(path: string): string | null {
  const stripped = stripGitSuffix(path);
  const segments = stripped.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return null;
  }
  return segments.join("/");
}

export function parseRemote(repoUrl: string): ParsedRemote {
  const url = repoUrl.trim();
  if (url.length === 0 || url.includes("\0") || Buffer.byteLength(url, "utf8") > MAX_URL_BYTES) {
    return UNPARSED;
  }

  const scp = SCP_LIKE.exec(url);
  if (scp) {
    const host = scp[2]!.toLowerCase();
    return {
      transport: "ssh",
      host,
      repoPath: ownerRepo(scp[3]!),
      isGitHub: isGitHubHost(host),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNPARSED;
  }

  const host = parsed.hostname.toLowerCase();
  const repoPath = ownerRepo(parsed.pathname);

  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    return { transport: "https", host, repoPath, isGitHub: isGitHubHost(host) };
  }
  if (parsed.protocol === "ssh:") {
    return { transport: "ssh", host, repoPath, isGitHub: isGitHubHost(host) };
  }
  return UNPARSED;
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host === "www.github.com";
}

/**
 * The HTTPS form of an SSH remote, for the wizard's offer to switch a fresh
 * install onto the transport it can actually guide. Returns null when the URL
 * carries no owner/repo to rebuild from, so the offer is only made when the
 * result is certain to be the same repository.
 */
export function toHttpsUrl(repoUrl: string): string | null {
  const remote = parseRemote(repoUrl);
  if (remote.host === null || remote.repoPath === null) {
    return null;
  }
  if (remote.transport === "https") {
    return `https://${remote.host}/${remote.repoPath}.git`;
  }
  if (remote.transport === "ssh") {
    return `https://${remote.host}/${remote.repoPath}.git`;
  }
  return null;
}
