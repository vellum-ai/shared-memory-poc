import { describe, expect, test } from "bun:test";

import {
  ConceptPageFormatError,
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
  test("accepts the reference structure with LF or CRLF line endings", () => {
    expect(() => validateConceptPageFormat(HORSES)).not.toThrow();
    expect(() => validateConceptPageFormat(HORSES.replaceAll("\n", "\r\n"))).not.toThrow();
  });

  test("rejects pages that depart from the canonical structure", () => {
    const invalidPages = [
      HORSES.replace("summary: A few reliable facts about horse anatomy and behavior.\n", ""),
      HORSES.replace("tags: [animals]", "tags: [Animals]"),
      HORSES.replace("source: import:shared-repo", "source: conversation"),
      HORSES.replace("# Horses", "# Horse facts"),
      HORSES.replace("- Horses cannot vomit.\n- Horses can doze standing up.\n", ""),
      `${HORSES}\n# Another title\n`,
    ];

    for (const content of invalidPages) {
      expect(() => validateConceptPageFormat(content)).toThrow(ConceptPageFormatError);
    }
  });
});
