import type { ReactNode } from "react";

/**
 * A deliberately small markdown renderer.
 *
 * Concept pages are short prose, so headings, lists, fenced code, block quotes,
 * rules and a handful of inline marks cover them. Pulling in a real markdown
 * library would cost more bundle than the pages are worth, and the app only
 * ever renders content from the team's own repo.
 */

export interface ParsedDocument {
  /** Top-level scalar keys from the YAML frontmatter block, if there was one. */
  frontmatter: Record<string, string>;
  body: string;
}

const FRONTMATTER_FENCE = /^---\s*$/;

export function parseDocument(content: string): ParsedDocument {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0] ?? "")) {
    return { frontmatter: {}, body: content };
  }

  const end = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line));
  if (end === -1) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

/** Frontmatter list values render as chips, so `[a, b]` becomes `["a", "b"]`. */
export function parseListValue(value: string): string[] {
  const inner = value.replace(/^\[(.*)\]$/, "$1");
  return inner
    .split(",")
    .map((entry) => entry.trim().replace(/^["'](.*)["']$/, "$1"))
    .filter((entry) => entry.length > 0);
}

// Built fresh on every call rather than shared: `renderInline` recurses into
// the contents of bold and italic runs, and a single global regex would have
// its `lastIndex` reset underneath the outer loop, which never terminates.
const INLINE_SOURCE =
  "(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)|(\\[[^\\]]*\\]\\([^)\\s]*\\))";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = new RegExp(INLINE_SOURCE, "g");
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      // Links cannot navigate inside the sandbox, so the target is shown as a
      // tooltip on plain marked-up text rather than as a dead anchor.
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(
        <span class="md-link" key={key} title={href}>
          {label || href}
        </span>,
      );
    }

    cursor = match.index + token.length;
    pattern.lastIndex = cursor;
    match = pattern.exec(text);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*([-*_])\s*\1\s*\1[\s-*_]*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function renderMarkdown(body: string): ReactNode[] {
  const lines = body.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  const nextKey = () => `b${key++}`;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // closing fence
      blocks.push(
        <pre class="md-code" key={nextKey()}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr class="md-rule" key={nextKey()} />);
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 1, 6);
      const Tag = `h${level}` as "h1";
      blocks.push(
        <Tag class={`md-h md-h${level}`} key={nextKey()}>
          {renderInline(heading[2] ?? "", nextKey())}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const captured = QUOTE.exec(lines[index] ?? "");
        if (!captured) break;
        quoted.push(captured[1] ?? "");
        index += 1;
      }
      blocks.push(
        <blockquote class="md-quote" key={nextKey()}>
          {renderInline(quoted.join(" ").trim(), nextKey())}
        </blockquote>,
      );
      continue;
    }

    const listPattern = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (listPattern) {
      const items: string[] = [];
      while (index < lines.length) {
        const captured = listPattern.exec(lines[index] ?? "");
        if (!captured) break;
        items.push(captured[1] ?? "");
        index += 1;
      }
      const ListTag = listPattern === BULLET ? "ul" : "ol";
      blocks.push(
        <ListTag class="md-list" key={nextKey()}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        RULE.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push(
      <p class="md-p" key={nextKey()}>
        {renderInline(paragraph.join(" "), nextKey())}
      </p>,
    );
  }

  return blocks;
}
