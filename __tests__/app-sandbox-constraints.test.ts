import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the app against the sandbox it actually runs in.
 *
 * The host renders a plugin app in an iframe sandboxed as `allow-scripts
 * allow-popups allow-popups-to-escape-sandbox` — notably without
 * `allow-forms`. A `<form>` inside it cannot submit: the browser blocks the
 * submission and the `onSubmit` handler never runs, so a Save button does
 * nothing whatsoever. The only evidence is a console line —
 * "Blocked form submission to '' because the form's frame is sandboxed" —
 * which nobody sees unless devtools happen to be open.
 *
 * That shipped once and made the setup wizard's Save button inert. A grep is a
 * blunt guard, but the failure is silent, browser-only, and invisible to every
 * other test in this repo, so a blunt guard beats none.
 */

const APP_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "knowledge", "src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const FILES = sourceFiles(APP_SRC);

/**
 * Comments are stripped before scanning: the components that explain *why*
 * `<form>` is banned have to name it, and a guard that fires on its own
 * rationale would only teach people to delete the explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Reports the offending lines rather than dumping the whole file on failure. */
function offendingLines(path: string, pattern: RegExp): string[] {
  return withoutComments(readFileSync(path, "utf8"))
    .split("\n")
    .map((line, index) => [index + 1, line] as const)
    .filter(([, line]) => pattern.test(line))
    .map(([number, line]) => `${number}: ${line.trim()}`);
}

const CASES = FILES.map((path) => [path.slice(APP_SRC.length + 1), path] as const);

describe("plugin app sandbox constraints", () => {
  test("finds the app sources to scan", () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  test.each(CASES)("%s renders no <form> element", (_label, path) => {
    expect(offendingLines(path, /<form[\s>/]/)).toEqual([]);
  });

  test.each(CASES)("%s declares no submit button", (_label, path) => {
    expect(offendingLines(path, /type=["']submit["']/)).toEqual([]);
  });
});
