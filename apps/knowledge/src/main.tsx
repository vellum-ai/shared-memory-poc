import { useEffect, useState } from "react";
import { render } from "react-dom";

import type { SummaryResponse } from "./api";
import { fetchSummary } from "./api";
import { useResource } from "./hooks";
import { ActivityTab } from "./tabs/Activity";
import { BrowseTab } from "./tabs/Browse";
import { ContributorsTab } from "./tabs/Contributors";
import { OverviewTab } from "./tabs/Overview";

import "./styles.css";

const SUMMARY_POLL_MS = 60_000;
const DEFAULT_BASE_ID = "default";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "contributors", label: "Contributors" },
  { id: "activity", label: "Activity" },
  { id: "browse", label: "Browse" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function App() {
  const summary = useResource<SummaryResponse>(fetchSummary, [], {
    pollMs: SUMMARY_POLL_MS,
  });

  const [tab, setTab] = useState<TabId>("overview");
  const [baseId, setBaseId] = useState(DEFAULT_BASE_ID);
  const [days, setDays] = useState(90);

  // Browse state lives here so switching tabs does not lose the reader.
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const bases = summary.data?.bases ?? null;

  useEffect(() => {
    if (!bases || bases.length === 0) return;
    if (bases.some((base) => base.id === baseId)) return;
    setBaseId(bases[0]?.id ?? DEFAULT_BASE_ID);
  }, [bases, baseId]);

  const onSelectPath = (path: string | null) => {
    setSelectedPath(path);
  };

  return (
    <div class="app">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path
                  d="M3.5 4.2C3.5 3.4 4.1 2.8 4.9 2.8h4.2c.8 0 1.4.6 1.4 1.4v11.8c0-.8-.6-1.4-1.4-1.4H4.9c-.8 0-1.4-.6-1.4-1.4V4.2Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
                <path
                  d="M16.5 4.2c0-.8-.6-1.4-1.4-1.4h-4.2c-.8 0-1.4.6-1.4 1.4v11.8c0-.8.6-1.4 1.4-1.4h4.2c.8 0 1.4-.6 1.4-1.4V4.2Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <h1 class="brand-title">Shared knowledge</h1>
          </div>

          {bases && bases.length > 1 ? (
            <label class="base-picker">
              <span class="base-picker-label">Base</span>
              <select
                value={baseId}
                onChange={(event) => setBaseId((event.target as HTMLSelectElement).value)}
              >
                {bases.map((base) => (
                  <option value={base.id} key={base.id}>
                    {base.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <nav class="tabs" aria-label="Sections">
          <div class="tabs-inner">
            {TABS.map((entry) => (
              <button
                class={entry.id === tab ? "tab tab-on" : "tab"}
                type="button"
                key={entry.id}
                aria-current={entry.id === tab ? "page" : undefined}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      <main class="content">
        {tab === "overview" ? (
          <OverviewTab
            baseId={baseId}
            bases={bases}
            loading={summary.loading}
            error={summary.error}
            onRetry={summary.reload}
          />
        ) : null}

        {tab === "contributors" ? (
          <ContributorsTab baseId={baseId} days={days} onDaysChange={setDays} />
        ) : null}

        {tab === "activity" ? <ActivityTab baseId={baseId} /> : null}

        {tab === "browse" ? (
          <BrowseTab
            baseId={baseId}
            query={query}
            onQueryChange={setQuery}
            selectedPath={selectedPath}
            onSelect={onSelectPath}
          />
        ) : null}
      </main>
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
