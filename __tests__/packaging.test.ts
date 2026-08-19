import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards how this plugin declares `@vellumai/plugin-api`.
 *
 * The host supplies the plugin API as a generated shim in the *workspace's*
 * `node_modules`, rebuilt from the running assistant's own export list. Node
 * resolves the nearest `node_modules` first, so a real copy of the package
 * inside this plugin's directory silently wins — and the published package
 * lags the assistant, so every host function newer than the last npm release
 * resolves to `undefined`.
 *
 * That is not hypothetical. Running a bare `bun install` on a deployed install
 * pulled `@vellumai/plugin-api@0.11.3` into the plugin's own `node_modules`,
 * which shadowed a shim that did export `storeCredential`. The setup screen
 * then told the user their assistant was too old to store a credential, on an
 * assistant that was perfectly capable of it.
 *
 * Keeping the package out of `dependencies` is what makes
 * `bun install --production` safe on a deployed clone, and keeping `preact`
 * in `dependencies` is what makes that command still install what the app
 * build needs.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const PLUGIN_API = "@vellumai/plugin-api";

describe("package.json", () => {
  test("never lists the plugin API as a runtime dependency", () => {
    expect(pkg.dependencies ?? {}).not.toHaveProperty(PLUGIN_API);
  });

  test("declares the plugin API as a peer dependency, which the host satisfies", () => {
    expect(pkg.peerDependencies ?? {}).toHaveProperty(PLUGIN_API);
  });

  test("keeps the plugin API available for local typechecking", () => {
    expect(pkg.devDependencies ?? {}).toHaveProperty(PLUGIN_API);
  });

  // `bun install --production` skips devDependencies, so anything the deployed
  // install needs on disk has to be a real dependency. The app bundle is built
  // on the deployed install, not shipped, so its framework counts.
  test("lists preact as a runtime dependency, since the app is built on deploy", () => {
    expect(pkg.dependencies ?? {}).toHaveProperty("preact");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("preact");
  });
});
