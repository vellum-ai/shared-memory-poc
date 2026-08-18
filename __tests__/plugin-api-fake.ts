/**
 * An in-memory stand-in for the host's credential vault.
 *
 * It replaces `src/setup/host-credentials.ts`, the plugin's own seam onto the
 * vault, rather than `@vellumai/plugin-api` itself. That is not a preference —
 * `mock.module` can override a name a module already exports but cannot add one
 * it does not, and the vendored package predates `storeCredential`. Faking the
 * package would silently leave the write path unreachable while every other
 * call appeared to work.
 *
 * Mocking the seam has a second benefit: nothing here touches the real plugin
 * API, so suites that use it for unrelated reasons — `getAssistantName` in the
 * publish tests — are unaffected however the files interleave.
 *
 * The registration is shared rather than repeated per suite because
 * `mock.module` applies to the whole test *process*. Two suites each declaring
 * their own would have the later one replace the earlier, and the loser would
 * fail only when they ran together.
 */

import { mock } from "bun:test";

interface FakeState {
  /** What the vault holds for `github/shared-memory`, or null when empty. */
  token: string | null;
  /** Refs passed to the write, in order, so scope can be asserted. */
  storedRefs: string[];
  /** When set, the next write rejects with it. */
  storeFailure: Error | null;
}

const state: FakeState = {
  token: null,
  storedRefs: [],
  storeFailure: null,
};

class FakeHostTooOldError extends Error {}

mock.module("../src/setup/host-credentials.js", () => ({
  HostTooOldError: FakeHostTooOldError,

  readCredential: async (ref: string): Promise<string | null> =>
    ref === "github/shared-memory" ? state.token : null,

  writeCredential: async (ref: string, value: string): Promise<void> => {
    if (state.storeFailure) {
      throw state.storeFailure;
    }
    state.storedRefs.push(ref);
    state.token = value;
  },
}));

export const pluginApiFake = {
  /** Restore the empty-vault, everything-works baseline. */
  reset(): void {
    state.token = null;
    state.storedRefs = [];
    state.storeFailure = null;
  },
  setToken(token: string | null): void {
    state.token = token;
  },
  get token(): string | null {
    return state.token;
  },
  get storedRefs(): readonly string[] {
    return state.storedRefs;
  },
  failNextStore(error: Error): void {
    state.storeFailure = error;
  },
  /** The error type the seam raises for a host without the write call. */
  HostTooOldError: FakeHostTooOldError,
};
