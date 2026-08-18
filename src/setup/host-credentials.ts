/**
 * The plugin's single point of contact with the host's credential vault.
 *
 * Two reasons this thin layer exists rather than calling the plugin API
 * directly from `credential.ts`.
 *
 * The API arrives as a generated shim whose export list is fixed when it is
 * written, and `storeCredential` is newer than the published package. A named
 * import of it fails to *link* against an older shim, and a link failure takes
 * down every module that imports it — all four setup routes, not just the one
 * step that needs the call. Reading it off a namespace defers that to call
 * time, so an older host loses one step and says why.
 *
 * And it gives the setup code one seam to substitute in tests. The shim cannot
 * be faked for a name it does not export, so a test that wanted to exercise the
 * store path had no way to reach it.
 *
 * Neither reason survives the package catching up. When it does, fold this back
 * into `credential.ts` as ordinary named imports and delete
 * `plugin-api-pending.d.ts`.
 */

import * as pluginApi from "@vellumai/plugin-api";

/** Raised when the running host is too old to have the write call. */
export class HostTooOldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostTooOldError";
  }
}

/**
 * A credential's plaintext, or null when it cannot be read.
 *
 * The reference not matching, the store being unreachable and the scope check
 * refusing all leave the caller with no credential and the same next move, so
 * they collapse to one answer here rather than three the caller must re-join.
 */
export async function readCredential(ref: string): Promise<string | null> {
  try {
    return await pluginApi.resolveCredential(ref);
  } catch {
    return null;
  }
}

/**
 * Write a credential's plaintext, creating it if it does not exist.
 *
 * **Call this from a request handler, never at module scope.** The host scopes
 * the write to the plugin currently executing and fails closed when there is
 * none — and a plugin's modules are imported by the loader outside that
 * context, so a top-level call would be refused rather than run unscoped.
 *
 * That also means the `typeof` check below only proves the call exists, not
 * that it will succeed. Whether the context is right is knowable only by
 * calling it, so its refusal is reported rather than pre-empted.
 */
export async function writeCredential(
  ref: string,
  value: string,
  options: { label?: string; description?: string },
): Promise<void> {
  const store = pluginApi.storeCredential as typeof pluginApi.storeCredential | undefined;
  if (typeof store !== "function") {
    throw new HostTooOldError(
      "This assistant cannot store a credential for a plugin yet. Update the assistant, or set it from a terminal with: assistant credentials set --service github --field shared-memory <token>",
    );
  }
  await store(ref, value, options);
}
