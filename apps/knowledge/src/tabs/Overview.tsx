import type { DigestAuthor, DigestStatus, KnowledgeBase, PendingResponse } from "../api";
import { fetchPending } from "../api";
import { Card, EmptyState, ErrorBanner, NameChip, Skeleton, Stat } from "../components";
import { absoluteTime, duration, pluralize, relativeTime, shortSha } from "../format";
import { useResource } from "../hooks";

const POLL_MS = 60_000;

const DIGEST_MODE_LABEL: Record<string, string> = {
  deterministic: "Deterministic",
  llm: "LLM prose",
};

const QUIET_STATUS_TEXT: Record<Exclude<DigestStatus, "changes">, string> = {
  unconfigured: "No repo is configured yet, so there is nothing to report.",
  "no-sync": "The repo has not synced yet. The first digest waits for it.",
  baselined: "Baselined at the current commit. The next digest covers what comes after it.",
  "no-changes": "Nothing new since the last digest.",
};

export function OverviewTab({
  baseId,
  bases,
  loading,
  error,
  onRetry,
}: {
  baseId: string;
  bases: KnowledgeBase[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const pending = useResource<PendingResponse>(() => fetchPending(baseId), [baseId], {
    pollMs: POLL_MS,
  });

  return (
    <div class="stack">
      <ErrorBanner message={error} onRetry={onRetry} />

      {bases === null && loading ? (
        <Card title="Knowledge base">
          <Skeleton lines={4} />
        </Card>
      ) : null}

      {bases !== null && bases.length === 0 ? (
        <Card title="Knowledge bases">
          <EmptyState title="No knowledge base is installed.">
            <p>
              The plugin reports no base at all. Check that the plugin is enabled and that the
              assistant has restarted since it was installed.
            </p>
          </EmptyState>
        </Card>
      ) : null}

      {(bases ?? []).map((base) => (
        <BaseCard base={base} key={base.id} />
      ))}

      <PendingCard
        data={pending.data}
        loading={pending.loading}
        error={pending.error}
        onRetry={pending.reload}
      />
    </div>
  );
}

function BaseCard({ base }: { base: KnowledgeBase }) {
  if (!base.configured) {
    return (
      <Card title={<span class="mono">{base.id}</span>}>
        <EmptyState title="This base is not configured yet.">
          <p>
            Copy <code>config.example.json</code> to <code>config.json</code> in the plugin
            directory and set <code>repoUrl</code> to your team's content repo. Set{" "}
            <code>branch</code> too if it is not <code>main</code>.
          </p>
          <p>Sync picks the change up on its next tick; nothing needs re-arming.</p>
        </EmptyState>
      </Card>
    );
  }

  const counts = base.counts;
  const identityMissing = !base.health.identityConfigured || base.author === null;

  return (
    <Card
      title={
        <>
          <span class="mono">{base.repoUrl ?? base.id}</span>
          <span class="branch-badge">{base.branch ?? "main"}</span>
        </>
      }
      actions={
        <span class="sync-freshness" title={absoluteTime(base.syncedAt)}>
          {base.syncedAt ? `synced ${relativeTime(base.syncedAt)}` : "never synced"}
        </span>
      }
    >
      <div class="stat-grid">
        <Stat label="Skills" value={counts ? counts.skills : "—"} />
        <Stat label="Pages" value={counts ? counts.pages : "—"} />
        <Stat label="Synced commit" value={<span class="mono">{shortSha(base.syncedHead)}</span>} />
        <Stat label="Digest commit" value={<span class="mono">{shortSha(base.digestHead)}</span>} />
        <Stat
          label="Digest mode"
          value={DIGEST_MODE_LABEL[base.digestMode] ?? base.digestMode}
        />
        <Stat
          label="Publishes as"
          tone={identityMissing ? "warn" : undefined}
          value={
            identityMissing ? (
              "not configured"
            ) : (
              <span title={base.author?.email}>{base.author?.name}</span>
            )
          }
        />
      </div>

      {identityMissing ? (
        <p class="notice notice-warn">
          No publishing identity. Publishing fails with <code>GIT_IDENTITY_MISSING</code> until an{" "}
          <code>author</code> block with a name and an email is set in <code>config.json</code>, or
          the guardian contact supplies one.
        </p>
      ) : (
        <p class="notice notice-quiet">
          Commits are authored as{" "}
          <span class="mono">
            {base.author?.name} &lt;{base.author?.email}&gt;
          </span>{" "}
          and committed by this assistant.
        </p>
      )}

      <div class="health-row">
        <HealthItem
          ok={base.clonePresent}
          okText="Clone present"
          warnText="Clone missing. Sync creates it on the next tick."
        />
        <HealthItem
          ok={!base.health.lockPresent}
          okText="No sync running"
          warnText={`Sync lock held for ${duration(base.health.lockAgeMs)}`}
          warnTone={
            base.health.lockPresent && (base.health.lockAgeMs ?? 0) > 35 * 60_000
              ? "warn"
              : "info"
          }
        />
      </div>
    </Card>
  );
}

function HealthItem({
  ok,
  okText,
  warnText,
  warnTone = "warn",
}: {
  ok: boolean;
  okText: string;
  warnText: string;
  warnTone?: "warn" | "info";
}) {
  const tone = ok ? "ok" : warnTone;
  return (
    <span class={`health health-${tone}`}>
      <span class="health-dot" aria-hidden="true" />
      {ok ? okText : warnText}
    </span>
  );
}

function PendingCard({
  data,
  loading,
  error,
  onRetry,
}: {
  data: PendingResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const digest = data?.digest ?? null;

  return (
    <Card title="Pending digest">
      <ErrorBanner message={error} onRetry={onRetry} />

      {digest === null ? (
        loading ? (
          <Skeleton lines={2} />
        ) : (
          <p class="quiet">No digest information is available.</p>
        )
      ) : digest.status === "changes" ? (
        <PendingChanges authors={digest.authors ?? []} range={digest.range} />
      ) : (
        <p class="quiet">{QUIET_STATUS_TEXT[digest.status]}</p>
      )}
    </Card>
  );
}

function PendingChanges({
  authors,
  range,
}: {
  authors: DigestAuthor[];
  range?: { start: string; end: string };
}) {
  if (authors.length === 0) {
    return <p class="quiet">Changes are pending, but no author was attributed to them.</p>;
  }

  return (
    <>
      <p class="quiet">
        {pluralize(authors.length, "author")} with changes waiting for the next digest
        {range ? (
          <>
            {" "}
            <span class="mono">
              {shortSha(range.start)}…{shortSha(range.end)}
            </span>
          </>
        ) : null}
        .
      </p>
      <ul class="author-list">
        {authors.map((entry) => (
          <li class="author-row" key={entry.author}>
            <span class="author-name">{entry.author}</span>
            <span class="chip-row">
              {renderChips(entry, "skill")}
              {renderChips(entry, "page")}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function renderChips(entry: DigestAuthor, kind: "skill" | "page") {
  const lists = kind === "skill" ? entry.skills : entry.pages;
  const actions = ["added", "updated", "removed"] as const;
  return actions.flatMap((action) =>
    (lists?.[action] ?? []).map((name) => (
      <NameChip action={action} kind={kind} name={name} key={`${kind}-${action}-${name}`} />
    )),
  );
}
