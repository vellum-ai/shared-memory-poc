/**
 * Types for `storeCredential`, which the host exports but the published
 * `@vellumai/plugin-api` package does not yet declare.
 *
 * The export lives on the assistant's own plugin-api surface (added on branch
 * `worktree-plugin-store-credential`, commit 5249b6fc27) and reaches an
 * installed plugin through the workspace shim, which derives its exports from
 * the host's index rather than from the npm artifact. So the symbol resolves at
 * runtime today while `node_modules/@vellumai/plugin-api/index.d.ts` still
 * describes 0.11.3, which predates it.
 *
 * This augmentation closes that gap and nothing else. Delete the whole file
 * once the package publishes a version that declares `storeCredential`, and
 * raise the `@vellumai/plugin-api` range in package.json to match — the
 * declarations below will then be shadowed by the real ones and silently rot.
 */

import "@vellumai/plugin-api";

declare module "@vellumai/plugin-api" {
  /** Optional metadata recorded alongside the stored value. */
  export interface StoreCredentialOptions {
    /** Human-friendly alias shown in credential listings. */
    label?: string;
    /** What the credential is for, surfaced to the agent. */
    description?: string;
    /**
     * Skip the retroactive sweep that removes the value from recent
     * transcripts. Only correct for a value that provably never transited a
     * conversation, such as a token minted by an OAuth refresh.
     */
    skipTranscriptScrub?: boolean;
  }

  /** Identity of the credential that was written. */
  export interface StoredCredentialRef {
    credentialId: string;
    service: string;
    field: string;
  }

  /**
   * Raised when a credential cannot be stored: the reference is malformed or
   * names no credential, the value is empty or invalid for its service, the
   * secure backend rejected the write, or the calling plugin is not permitted
   * to write the credential.
   */
  export class CredentialStoreError extends Error {
    constructor(message: string);
  }

  /**
   * Store a credential's plaintext value, creating it or replacing the value of
   * an existing one.
   *
   * Scoping mirrors {@link resolveCredential}: a plugin may only write
   * credentials whose `field` equals its own manifest name, so this plugin
   * writes `github/shared-memory` and nothing else.
   *
   * @param ref A credential UUID, or a `"service/field"` string which is
   *   created when no such credential exists.
   * @param value The plaintext value. Edge whitespace is trimmed.
   */
  export function storeCredential(
    ref: string,
    value: string,
    options?: StoreCredentialOptions,
  ): Promise<StoredCredentialRef>;
}
