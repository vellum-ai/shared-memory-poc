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

  test("quotes tags that YAML would type as non-strings", () => {
    const content = formatConceptPage({
      title: "Release labels",
      summary: "Tags used to group release knowledge.",
      tags: ["2026", "true", "null", "release-2026"],
      body: "Use the labels when organizing release pages.",
    });

    expect(content).toContain('tags: ["2026", "true", "null", release-2026]');
    expect(() => validateConceptPageFormat(content)).not.toThrow();
  });

  test("unwraps a complete page supplied as the structured body", () => {
    const content = formatConceptPage({
      title: "Horses",
      summary: "A few reliable facts about horse anatomy and behavior.",
      tags: ["animals"],
      body: HORSES,
    });

    expect(content).toBe(HORSES);
    expect(content.match(/^---$/gm)).toHaveLength(2);
    expect(content.match(/^# Horses$/gm)).toHaveLength(1);
  });

  test("preserves body content that only resembles a heading", () => {
    const content = formatConceptPage({
      title: "Release commands",
      summary: "Commands used during a release.",
      tags: ["release"],
      body: "# tag the release\ngit tag v1",
    });

    expect(content).toContain("# Release commands\n\n# tag the release\ngit tag v1");
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
