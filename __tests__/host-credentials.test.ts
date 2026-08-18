import { describe, expect, test } from "bun:test";

/**
 * The degradation path, tested against the real plugin API rather than a fake.
 *
 * Every other suite substitutes `host-credentials.js` so it can drive the vault.
 * This one deliberately does not: the package in `node_modules` genuinely lacks
 * `storeCredential`, which makes this checkout an exact reproduction of an
 * install running an assistant older than the release that ships it. Faking
 * anything here would test the fake instead of the condition.
 *
 * **This suite is meant to break.** When the published package gains
 * `storeCredential`, `writeCredential` will stop throwing and the first test
 * below will fail. That is the reminder to do the cleanup the README lists:
 * pin `peerDependencies`, delete `src/setup/plugin-api-pending.d.ts`, and fold
 * the namespace indirection in `src/setup/host-credentials.ts` back into named
 * imports. Delete this file in the same change.
 *
 * On ordering: `mock.module` is process-wide, so the suites that replace this
 * module could in principle reach it. They do not — a module imported directly
 * by a test file binds ahead of the mock — but the guarantee that matters is
 * that a leak could not pass unnoticed. The fake's `writeCredential` resolves,
 * so a leak makes the first test fail rather than quietly assert nothing.
 * Verified in both file orders.
 */

import { HostTooOldError, readCredential, writeCredential } from "../src/setup/host-credentials.js";

describe("writeCredential against a host without the call", () => {
  test("refuses rather than failing with an unexplained type error", async () => {
    await expect(
      writeCredential("github/shared-memory", "github_pat_example", {}),
    ).rejects.toBeInstanceOf(HostTooOldError);
  });

  test("names the CLI fallback, which is the only way through on such a host", async () => {
    try {
      await writeCredential("github/shared-memory", "github_pat_example", {});
      throw new Error("expected writeCredential to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(HostTooOldError);
      expect((error as Error).message).toContain("assistant credentials set");
      expect((error as Error).message).toContain("--field shared-memory");
    }
  });

  // The value is in the message's blast radius if anyone ever interpolates it,
  // and this message is rendered in the wizard.
  test("never puts the value in its refusal", async () => {
    try {
      await writeCredential("github/shared-memory", "github_pat_secret", {});
    } catch (error) {
      expect((error as Error).message).not.toContain("github_pat_secret");
    }
  });
});

describe("readCredential without a running host", () => {
  /**
   * The shim binds `resolveCredential` from the host's injection global, which
   * is empty outside the daemon — so the call is `undefined` here and invoking
   * it throws a TypeError. That is a different failure from "no such
   * credential", and the seam has to flatten both, or the setup screen would
   * 500 on a plugin loaded outside a daemon instead of reporting no token.
   */
  test("reads as absent rather than throwing", async () => {
    expect(await readCredential("github/shared-memory")).toBeNull();
  });
});
