const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_YAML_PLAIN_SCALAR = /^[A-Za-z][A-Za-z0-9 _./()'-]*$/;
const YAML_RESERVED_SCALAR = /^(?:false|null|no|off|on|true|yes)$/i;

export const MAX_CONCEPT_TITLE_LENGTH = 200;
export const MAX_CONCEPT_SUMMARY_LENGTH = 500;
export const MAX_CONCEPT_TAGS = 20;

export const CONCEPT_PAGE_SOURCE = "import:shared-repo";

export const CONCEPT_PAGE_TEMPLATE = `---
title: Topic title
summary: A concise description of the shared knowledge.
tags: [topic]
source: ${CONCEPT_PAGE_SOURCE}
---

# Topic title

Durable, reusable knowledge goes here.
`;

export const CONCEPT_PAGE_FORMAT_GUIDANCE =
  "Use structured page fields so the publisher renders the canonical template: YAML frontmatter with title, summary, tags, and source in that order; source is import:shared-repo; tags are unique lowercase slugs; the body starts with an H1 exactly matching title and contains non-empty Markdown.";

export const CONCEPT_PAGE_FORMAT = Object.freeze({
  guidance: CONCEPT_PAGE_FORMAT_GUIDANCE,
  template: CONCEPT_PAGE_TEMPLATE,
});

export class ConceptPageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptPageFormatError";
  }
}

export interface ConceptPageFields {
  title: string;
  summary: string;
  tags: string[];
  body: string;
}

function fail(message: string): never {
  throw new ConceptPageFormatError(message);
}

function normalizeInline(value: string, label: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized)
  ) {
    fail(`${label} must be short plain text.`);
  }
  return normalized;
}

function normalizeTags(tags: string[]): string[] {
  if (tags.length === 0 || tags.length > MAX_CONCEPT_TAGS) {
    fail(`Tags must contain between 1 and ${MAX_CONCEPT_TAGS} values.`);
  }
  const normalized = tags
    .map((tag) =>
      tag
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  if (unique.length === 0) {
    fail("Tags must contain at least one word or number.");
  }
  return unique;
}

function formatYamlString(value: string): string {
  if (SAFE_YAML_PLAIN_SCALAR.test(value) && !YAML_RESERVED_SCALAR.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function parseYamlString(value: string): string {
  if (SAFE_YAML_PLAIN_SCALAR.test(value) && !YAML_RESERVED_SCALAR.test(value)) {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("Title and summary must be valid YAML strings.");
  }
  if (typeof parsed === "string" && parsed.length > 0) {
    return parsed;
  }
  fail("Title and summary must be valid YAML strings.");
}

export function formatConceptPage(fields: ConceptPageFields): string {
  const title = normalizeInline(fields.title, "Title", MAX_CONCEPT_TITLE_LENGTH);
  const summary = normalizeInline(fields.summary, "Summary", MAX_CONCEPT_SUMMARY_LENGTH);
  const tags = normalizeTags(fields.tags);
  const body = fields.body.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0 || body.includes("\0")) {
    fail("The page body must contain non-empty Markdown text.");
  }

  return `---\ntitle: ${formatYamlString(title)}\nsummary: ${formatYamlString(summary)}\ntags: [${tags.join(", ")}]\nsource: ${CONCEPT_PAGE_SOURCE}\n---\n\n# ${title}\n\n${body}\n`;
}

export function validateConceptPageFormat(content: string): void {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    fail("The page must start with YAML frontmatter.");
  }

  const titleValue = /^title: (.+)$/.exec(lines[1] ?? "")?.[1]?.trim();
  const summaryValue = /^summary: (.+)$/.exec(lines[2] ?? "")?.[1]?.trim();
  const tagsValue = /^tags: \[(.+)]$/.exec(lines[3] ?? "")?.[1];
  if (!titleValue || !summaryValue || tagsValue === undefined) {
    fail("Frontmatter must contain non-empty title, summary, and inline tags in canonical order.");
  }
  const title = parseYamlString(titleValue);
  parseYamlString(summaryValue);
  if (lines[4] !== `source: ${CONCEPT_PAGE_SOURCE}` || lines[5] !== "---") {
    fail(`Frontmatter must end with source: ${CONCEPT_PAGE_SOURCE}.`);
  }

  const tags = tagsValue.split(",").map((tag) => tag.trim());
  if (
    tags.some((tag) => !TAG_PATTERN.test(tag)) ||
    new Set(tags).size !== tags.length
  ) {
    fail("Tags must be unique lowercase slugs separated by commas.");
  }
  if (lines[6] !== "" || lines[7] !== `# ${title}` || lines[8] !== "") {
    fail("The body must start with an H1 exactly matching the frontmatter title.");
  }

  const body = lines.slice(9).join("\n");
  if (body.trim().length === 0) {
    fail("The page body must contain durable shared knowledge.");
  }
}
