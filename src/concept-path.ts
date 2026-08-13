import { Buffer } from "node:buffer";

export const MAX_CONCEPT_PATH_BYTES = 240;
export const MAX_CONCEPT_FILE_BYTES = 64 * 1024;
export const MAX_EXACT_PATHS = 20;

const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_TOP_LEVEL_SEGMENTS = new Set(["cli-commands", "skills"]);

export class ConceptPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptPathError";
  }
}

export function validateConceptPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConceptPathError("Concept paths must be non-empty strings.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CONCEPT_PATH_BYTES) {
    throw new ConceptPathError(
      `Concept paths may be at most ${MAX_CONCEPT_PATH_BYTES} UTF-8 bytes.`,
    );
  }
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new ConceptPathError("Concept paths must be safe repository-relative paths.");
  }

  const parts = value.split("/");
  if (parts.length < 2 || parts[0] !== "concepts") {
    throw new ConceptPathError("Concept paths must be under concepts/.");
  }
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ConceptPathError("Concept paths may not contain empty or traversal segments.");
  }

  const filename = parts.at(-1) ?? "";
  if (!filename.endsWith(".md")) {
    throw new ConceptPathError("Concept paths must name Markdown files.");
  }

  const stem = filename.slice(0, -3);
  const directories = parts.slice(1, -1);
  if (!SEGMENT_PATTERN.test(stem) || directories.some((part) => !SEGMENT_PATTERN.test(part))) {
    throw new ConceptPathError(
      "Concept path segments must use lowercase letters, numbers, and single hyphens.",
    );
  }
  if (directories[0] && RESERVED_TOP_LEVEL_SEGMENTS.has(directories[0])) {
    throw new ConceptPathError(
      `Concept paths may not use ${directories[0]}/ as their top-level namespace.`,
    );
  }

  return value;
}

export function validateConceptPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXACT_PATHS) {
    throw new ConceptPathError(
      `Provide between 1 and ${MAX_EXACT_PATHS} exact concept paths.`,
    );
  }

  const paths = value.map(validateConceptPath);
  if (new Set(paths).size !== paths.length) {
    throw new ConceptPathError("Concept paths must be unique.");
  }
  return paths;
}
