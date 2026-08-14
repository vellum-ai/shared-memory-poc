import type { ActivityCommit, ActivityResponse } from "../api";
import { fetchActivity } from "../api";
import { Card, ChangeChip, EmptyState, ErrorBanner, Skeleton } from "../components";
import { absoluteTime, pluralize, relativeTime, shortSha } from "../format";
import { useResource } from "../hooks";

/** The feed shows whatever the commit window holds; the range is fixed here. */
const FEED_DAYS = 90;

export function ActivityTab({ baseId }: { baseId: string }) {
  const activity = useResource<ActivityResponse>(
    () => fetchActivity(baseId, FEED_DAYS),
    [baseId],
  );

  const commits = activity.data?.commits ?? [];

  return (
    <div class="stack">
      <ErrorBanner message={activity.error} onRetry={activity.reload} />

      <Card
        title="Recent commits"
        actions={
          activity.data ? (
            <span class="quiet">
              {pluralize(commits.length, "commit")} in the last {FEED_DAYS} days
            </span>
          ) : null
        }
      >
        {activity.data === null && activity.loading ? (
          <Skeleton lines={6} />
        ) : commits.length === 0 ? (
          <EmptyState title="No commits in the last 90 days.">
            <p>
              The feed fills in as the team publishes to the shared repo, and after the next sync
              brings those commits down.
            </p>
          </EmptyState>
        ) : (
          <ol class="feed">
            {commits.map((commit) => (
              <CommitRow commit={commit} key={commit.sha} />
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function CommitRow({ commit }: { commit: ActivityCommit }) {
  return (
    <li class="feed-row">
      <div class="feed-head">
        <span class="feed-time" title={absoluteTime(commit.date)}>
          {relativeTime(commit.date)}
        </span>
        <span class="feed-author">{commit.author}</span>
        <span class="feed-subject">{commit.subject}</span>
        <span class="feed-sha mono" title={commit.sha}>
          {shortSha(commit.sha)}
        </span>
      </div>
      {commit.changes.length > 0 ? (
        <div class="chip-row">
          {commit.changes.map((change, index) => (
            <ChangeChip change={change} key={`${change.kind}-${change.name}-${index}`} />
          ))}
        </div>
      ) : null}
    </li>
  );
}
