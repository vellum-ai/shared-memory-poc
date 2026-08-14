const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  "Every concept page must follow the canonical template: YAML frontmatter with title, summary, tags, and source in that order; source must be import:shared-repo; tags must be a non-empty inline list of lowercase slugs; the body must start with one H1 exactly matching title and contain non-empty Markdown.";

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

function fail(message: string): never {
  throw new ConceptPageFormatError(message);
}

export function validateConceptPageFormat(content: string): void {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    fail("The page must start with YAML frontmatter.");
  }

  const title = /^title: (.+)$/.exec(lines[1] ?? "")?.[1]?.trim();
  const summary = /^summary: (.+)$/.exec(lines[2] ?? "")?.[1]?.trim();
  const tagsValue = /^tags: \[(.+)]$/.exec(lines[3] ?? "")?.[1];
  if (!title || !summary || tagsValue === undefined) {
    fail("Frontmatter must contain non-empty title, summary, and inline tags in canonical order.");
  }
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
  if (body.split(/\r?\n/).some((line) => /^#\s+/.test(line))) {
    fail("The title heading must be the page's only H1.");
  }
}
