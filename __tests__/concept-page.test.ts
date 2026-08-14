import { describe, expect, test } from "bun:test";

import {
  ConceptPageFormatError,
  formatConceptPage,
  validateConceptPageFormat,
} from "../src/concept-page.js";

const HORSES = `---
title: Horses
summary: A few reliable facts about horse anatomy and behavior.
tags: [animals]
source: import:shared-repo
---

# Horses

- Horses cannot vomit.
- Horses can doze standing up.
`;

describe("canonical concept page format", () => {
  test("renders structured fields in the reference format", () => {
    expect(
      formatConceptPage({
        title: "  Horses  ",
        summary: "A few reliable facts about horse anatomy and behavior.",
        tags: ["Animals", "horse facts", "animals"],
        body: "- Horses cannot vomit.\r\n- Horses can doze standing up.",
      }),
    ).toBe(HORSES.replace("tags: [animals]", "tags: [animals, horse-facts]"));
  });

  test("accepts the reference structure with LF or CRLF line endings", () => {
    expect(() => validateConceptPageFormat(HORSES)).not.toThrow();
    expect(() => validateConceptPageFormat(HORSES.replaceAll("\n", "\r\n"))).not.toThrow();
  });

  test("quotes YAML-sensitive structured fields", () => {
    const content = formatConceptPage({
      title: "Runbook: deploy",
      summary: "Release steps # shared",
      tags: ["ops"],
      body: "Use the release checklist.",
    });

    expect(content).toContain('title: "Runbook: deploy"');
    expect(content).toContain('summary: "Release steps # shared"');
    expect(content).toContain("# Runbook: deploy");
    expect(() => validateConceptPageFormat(content)).not.toThrow();
  });

  test("rejects pages that depart from the canonical structure", () => {
    const invalidPages = [
      HORSES.replace("summary: A few reliable facts about horse anatomy and behavior.\n", ""),
      HORSES.replace("tags: [animals]", "tags: [Animals]"),
      HORSES.replace("source: import:shared-repo", "source: conversation"),
      HORSES.replace("# Horses", "# Horse facts"),
      HORSES.replace("- Horses cannot vomit.\n- Horses can doze standing up.\n", ""),
    ];

    for (const content of invalidPages) {
      expect(() => validateConceptPageFormat(content)).toThrow(ConceptPageFormatError);
    }
  });
});
