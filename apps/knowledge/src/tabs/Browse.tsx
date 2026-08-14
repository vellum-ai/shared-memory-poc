import type { PageResponse, SearchResponse } from "../api";
import { fetchActivity, fetchPage, fetchSearch } from "../api";
import { Card, EmptyState, ErrorBanner, Skeleton } from "../components";
import { changePath, pathLabel, relativeTime } from "../format";
import { useDebounced, useResource } from "../hooks";
import { parseDocument, parseListValue, renderMarkdown } from "../markdown";

const MIN_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 300;
const RECENT_DAYS = 90;
const RECENT_LIMIT = 40;

export interface PageListItem {
  /** Repo-relative path, the value `/page` takes. */
  path: string;
  label: string;
  detail?: string;
}

/**
 * Where the browse list gets its entries.
 *
 * v1 has no list-all endpoint, so the default source derives a starting list
 * from recent activity. When a `list` route lands, write a second source with
 * this signature and hand it to `PageList` — nothing else has to change.
 */
export type PageListSource = (baseId: string) => Promise<PageListItem[]>;

export const recentPagesSource: PageListSource = async (baseId) => {
  const activity = await fetchActivity(baseId, RECENT_DAYS);
  const seen = new Map<string, PageListItem>();

  // Commits arrive newest first, so the first sighting of a path is its latest.
  for (const commit of activity.commits) {
    for (const change of commit.changes) {
      if (change.kind !== "page") continue;
      if (change.action === "removed") continue;
      const path = changePath(change);
      if (seen.has(path)) continue;
      seen.set(path, {
        path,
        label: change.name,
        detail: `${change.action} ${relativeTime(commit.date)} by ${commit.author}`,
      });
      if (seen.size >= RECENT_LIMIT) break;
    }
    if (seen.size >= RECENT_LIMIT) break;
  }

  return [...seen.values()];
};

export function BrowseTab({
  baseId,
  query,
  onQueryChange,
  selectedPath,
  onSelect,
  source = recentPagesSource,
}: {
  baseId: string;
  query: string;
  onQueryChange: (query: string) => void;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  source?: PageListSource;
}) {
  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);
  const searching = debounced.length >= MIN_QUERY_LENGTH;

  const recent = useResource<PageListItem[]>(() => source(baseId), [baseId, source]);
  const search = useResource<SearchResponse>(
    () => fetchSearch(baseId, debounced),
    [baseId, debounced],
    { enabled: searching },
  );

  const searchItems: PageListItem[] = (search.data?.matches ?? []).map((match) => ({
    path: match.path,
    label: pathLabel(match.path),
    detail: match.truncated ? `${match.excerpt}…` : match.excerpt,
  }));

  const items = searching ? searchItems : (recent.data ?? []);
  const listLoading = searching ? search.loading && search.data === null : recent.loading && recent.data === null;
  const listError = searching ? search.error : recent.error;
  const reload = searching ? search.reload : recent.reload;

  return (
    <div class="browse">
      <div class="browse-list">
        <div class="search-row">
          <svg class="search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M10.4 10.4 14 14"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          <input
            class="search-input"
            type="search"
            value={query}
            placeholder="Search the shared knowledge"
            aria-label="Search the shared knowledge"
            onInput={(event) => onQueryChange((event.target as HTMLInputElement).value)}
          />
          {query ? (
            <button class="search-clear" type="button" onClick={() => onQueryChange("")}>
              Clear
            </button>
          ) : null}
        </div>

        <p class="list-caption">
          {searching ? (
            <>
              Results for <span class="caption-query">{debounced}</span>
              {search.data?.truncated ? " (list truncated)" : ""}
            </>
          ) : (
            "Pages seen in recent activity"
          )}
        </p>

        <ErrorBanner message={listError} onRetry={reload} />

        <PageList
          items={items}
          loading={listLoading}
          selectedPath={selectedPath}
          onSelect={onSelect}
          emptyTitle={
            searching ? "No page matches that search." : "No pages in recent activity."
          }
          emptyBody={
            searching
              ? "Try a shorter term, or a word that appears in the page body."
              : "The list fills in once the team publishes pages and sync brings them down."
          }
        />
      </div>

      <div class="browse-reader">
        {selectedPath ? (
          <PageReader baseId={baseId} path={selectedPath} />
        ) : (
          <Card title="Reader">
            <EmptyState title="Pick a page to read it.">
              <p>Search above, or choose one of the pages from recent activity.</p>
            </EmptyState>
          </Card>
        )}
      </div>
    </div>
  );
}

export function PageList({
  items,
  loading,
  selectedPath,
  onSelect,
  emptyTitle,
  emptyBody,
}: {
  items: PageListItem[];
  loading: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  emptyTitle: string;
  emptyBody: string;
}) {
  if (loading && items.length === 0) return <Skeleton lines={6} class="skeleton-list" />;

  if (items.length === 0) {
    return (
      <EmptyState title={emptyTitle}>
        <p>{emptyBody}</p>
      </EmptyState>
    );
  }

  return (
    <ul class="page-list">
      {items.map((item) => (
        <li key={item.path}>
          <button
            class={item.path === selectedPath ? "page-item page-item-on" : "page-item"}
            type="button"
            onClick={() => onSelect(item.path)}
          >
            <span class="page-item-label">{item.label}</span>
            {item.detail ? <span class="page-item-detail">{item.detail}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function PageReader({ baseId, path }: { baseId: string; path: string }) {
  const page = useResource<PageResponse>(() => fetchPage(baseId, path), [baseId, path]);

  if (page.data === null) {
    return (
      <Card title={pathLabel(path)}>
        <ErrorBanner message={page.error} onRetry={page.reload} />
        {page.loading ? <Skeleton lines={8} /> : page.error ? null : <p class="quiet">Empty page.</p>}
      </Card>
    );
  }

  const { frontmatter, body } = parseDocument(page.data.content);
  const title = frontmatter["title"] ?? pathLabel(page.data.path);
  const summary = frontmatter["summary"];
  const tags = frontmatter["tags"] ? parseListValue(frontmatter["tags"]) : [];

  return (
    <Card
      title={title}
      actions={<span class="mono quiet">{page.data.path}</span>}
    >
      <ErrorBanner message={page.error} onRetry={page.reload} />
      {summary ? <p class="page-summary">{summary}</p> : null}
      {tags.length > 0 ? (
        <div class="chip-row">
          {tags.map((tag) => (
            <span class="tag-chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <article class="markdown">{renderMarkdown(body)}</article>
    </Card>
  );
}
