/**
 * The setup screen, shown in place of the dashboard until setup is finished.
 *
 * A fresh install has nothing to show on any of the four tabs — no repository,
 * no clone, no commits — so the dashboard would render four empty states and
 * leave the user to work out which of them is the actual problem. This replaces
 * all of that with the one thing worth doing, in order.
 *
 * Every step explains why it is asking before it asks. The server decides which
 * steps are done and what is blocking them (see `src/setup/status.ts`); this
 * renders that verdict rather than deciding for itself, so the wizard and the
 * sync it is configuring cannot disagree about what "ready" means.
 */

import { useState } from "react";

import { errorMessage } from "../api";
import { Button, ErrorBanner, Field, Skeleton } from "../components";
import {
  currentStep,
  type SetupStatus,
  type StepId,
  type StepState,
  runSetupSync,
  saveSetupConfig,
  saveSetupToken,
} from "./api";

const TOKEN_DOCS = "https://github.com/settings/personal-access-tokens";

const STEP_TITLES: Record<StepId, string> = {
  repository: "Connect a repository",
  access: "Give the plugin access",
  identity: "Name the author of your commits",
  sync: "Pull in what is already there",
};

function StepMark({ state, index }: { state: StepState; index: number }) {
  if (state === "done") {
    return (
      <span class="step-mark step-mark-done" aria-label="Done">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3.5 8.5 6.5 11.5 12.5 5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span class="step-mark step-mark-blocked" aria-label="Needs attention">
        !
      </span>
    );
  }
  return <span class="step-mark">{index + 1}</span>;
}

export function SetupWizard({
  status,
  loading,
  error,
  onStatus,
  onReload,
  onDismiss,
}: {
  status: SetupStatus | null;
  loading: boolean;
  error: string | null;
  onStatus: (status: SetupStatus) => void;
  onReload: () => void;
  /** Offered once setup is complete, to move on to the dashboard. */
  onDismiss: () => void;
}) {
  if (!status) {
    return (
      <div class="setup">
        <ErrorBanner message={error} onRetry={onReload} />
        {loading ? <Skeleton lines={5} /> : null}
      </div>
    );
  }

  const open = currentStep(status);

  return (
    <div class="setup">
      <header class="setup-head">
        <h1 class="setup-title">Set up shared knowledge</h1>
        <p class="setup-lede">
          This plugin keeps your assistant in sync with a git repository your team writes into.
          Three things to settle, then it runs on its own.
        </p>
      </header>

      <ErrorBanner message={error} onRetry={onReload} />

      <ol class="step-list">
        {status.steps.map((step, index) => (
          <li
            class={`step step-${step.state}${step.id === open ? " step-open" : ""}`}
            key={step.id}
          >
            <div class="step-head">
              <StepMark state={step.state} index={index} />
              <div class="step-heading">
                <h2 class="step-title">{STEP_TITLES[step.id]}</h2>
                <p class="step-detail">{step.detail}</p>
              </div>
            </div>

            {step.id === open ? (
              <div class="step-body">
                {step.id === "repository" ? (
                  <RepositoryStep status={status} onStatus={onStatus} />
                ) : null}
                {step.id === "access" ? (
                  <AccessStep status={status} onStatus={onStatus} />
                ) : null}
                {step.id === "identity" ? (
                  <IdentityStep status={status} onStatus={onStatus} />
                ) : null}
                {step.id === "sync" ? (
                  <SyncStep status={status} onStatus={onStatus} onDismiss={onDismiss} />
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      {status.complete ? (
        <div class="setup-foot">
          <Button variant="primary" onClick={onDismiss}>
            Open the dashboard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shared submit plumbing. Every step does the same three things — disable while
 * in flight, show the failure in place, hand a fresh status upward — and the
 * only interesting part is the call itself.
 */
function useSubmit(onStatus: (status: SetupStatus) => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async <T extends { status: SetupStatus }>(
    run: () => Promise<T>,
    after?: (result: T) => void,
  ) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await run();
      onStatus(result.status);
      after?.(result);
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return { busy, failure, submit };
}

function RepositoryStep({
  status,
  onStatus,
}: {
  status: SetupStatus;
  onStatus: (status: SetupStatus) => void;
}) {
  const [repoUrl, setRepoUrl] = useState(status.repoUrl ?? "");
  const [branch, setBranch] = useState(status.branch);
  const { busy, failure, submit } = useSubmit(onStatus);

  return (
    <form
      class="step-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => saveSetupConfig({ repoUrl, branch }));
      }}
    >
      <Field
        id="setup-repo-url"
        label="Repository URL"
        value={repoUrl}
        onInput={setRepoUrl}
        placeholder="https://github.com/your-org/your-shared-knowledge.git"
        hint={
          <>
            An <code>https://</code> address lets this screen finish setup on its own. A{" "}
            <code>git@</code> address works too, but it authenticates with an SSH key you set up
            outside this app. Anything else git clones — a <code>file://</code> URL or a local
            path — works and needs no credential.
          </>
        }
      />
      <Field
        id="setup-branch"
        label="Branch"
        value={branch}
        onInput={setBranch}
        placeholder="main"
        hint="The branch shared content is read from and published to."
      />
      {failure ? <p class="step-failure" role="alert">{failure}</p> : null}
      <Button variant="primary" type="submit" busy={busy}>
        {busy ? "Saving…" : "Save repository"}
      </Button>
    </form>
  );
}

function AccessStep({
  status,
  onStatus,
}: {
  status: SetupStatus;
  onStatus: (status: SetupStatus) => void;
}) {
  const [token, setToken] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [noteBad, setNoteBad] = useState(false);
  const { busy, failure, submit } = useSubmit(onStatus);

  // An SSH remote that has never cloned cannot be fixed from here. The offer to
  // switch to HTTPS is the only useful action, so it is the only one shown.
  if (status.transport === "ssh") {
    return (
      <div class="step-form">
        <p class="step-note">
          An SSH address authenticates with a key on this machine, registered with GitHub. Nothing
          on this screen can create that key.
        </p>
        {status.httpsAlternative ? (
          <>
            <p class="step-note">
              Switching to the HTTPS address for the same repository lets you finish here with a
              token instead.
            </p>
            {failure ? <p class="step-failure" role="alert">{failure}</p> : null}
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                void submit(() => saveSetupConfig({ repoUrl: status.httpsAlternative! }));
              }}
            >
              {busy ? "Switching…" : `Switch to ${status.httpsAlternative}`}
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <form
      class="step-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(
          () => saveSetupToken(token),
          (result) => {
            setNote(result.message ?? null);
            setNoteBad(!result.verified);
            // The value is in the vault now, so holding it in the form would
            // only keep a second copy alive in the page.
            if (result.verified) setToken("");
          },
        );
      }}
    >
      <p class="step-note">
        Create a token at{" "}
        <a href={TOKEN_DOCS} target="_blank" rel="noreferrer">
          github.com/settings/personal-access-tokens
        </a>
        , scoped to {status.repoPath ? <code>{status.repoPath}</code> : "your shared repository"}{" "}
        with <strong>Contents: read and write</strong>. Read alone is enough to receive shared
        knowledge; write is what lets this assistant publish back.
      </p>
      <Field
        id="setup-token"
        label="GitHub token"
        type="password"
        value={token}
        onInput={setToken}
        placeholder="github_pat_… or ghp_…"
        autocomplete="off"
        hint="Stored in the assistant's encrypted vault, never in the plugin's config file."
      />
      {failure ? <p class="step-failure" role="alert">{failure}</p> : null}
      {note ? (
        <p class={noteBad ? "step-failure" : "step-success"} role="status">
          {note}
        </p>
      ) : null}
      <Button variant="primary" type="submit" busy={busy}>
        {busy ? "Checking…" : "Save and check token"}
      </Button>
    </form>
  );
}

function IdentityStep({
  status,
  onStatus,
}: {
  status: SetupStatus;
  onStatus: (status: SetupStatus) => void;
}) {
  const [name, setName] = useState(status.author?.name ?? "");
  const [email, setEmail] = useState(status.author?.email ?? "");
  const { busy, failure, submit } = useSubmit(onStatus);

  return (
    <form
      class="step-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => saveSetupConfig({ author: { name, email } }));
      }}
    >
      <p class="step-note">
        Commits this assistant publishes are attributed to you, so your team can see who shared
        what. The assistant is recorded separately as the committer.
      </p>
      <Field
        id="setup-author-name"
        label="Name"
        value={name}
        onInput={setName}
        placeholder="Alex Chen"
      />
      <Field
        id="setup-author-email"
        label="Email"
        type="email"
        value={email}
        onInput={setEmail}
        placeholder="alex@example.com"
      />
      {failure ? <p class="step-failure" role="alert">{failure}</p> : null}
      <Button variant="primary" type="submit" busy={busy}>
        {busy ? "Saving…" : "Save author"}
      </Button>
    </form>
  );
}

function SyncStep({
  status,
  onStatus,
  onDismiss,
}: {
  status: SetupStatus;
  onStatus: (status: SetupStatus) => void;
  onDismiss: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [noteBad, setNoteBad] = useState(false);
  const { busy, failure, submit } = useSubmit(onStatus);

  return (
    <div class="step-form">
      <p class="step-note">
        Sync clones the repository, registers the skills it contains, and files its pages into
        memory. It runs on a schedule from here on; this just does the first one now.
      </p>
      {failure ? <p class="step-failure" role="alert">{failure}</p> : null}
      {note ? (
        <pre class={noteBad ? "step-log step-log-bad" : "step-log"}>{note}</pre>
      ) : null}
      <div class="step-actions">
        <Button
          variant="primary"
          busy={busy}
          onClick={() => {
            void submit(
              () => runSetupSync(),
              (result) => {
                setNoteBad(!result.synced);
                setNote(
                  result.synced
                    ? "Synced. Your shared knowledge is in."
                    : (result.message ?? "The sync did not finish."),
                );
              },
            );
          }}
        >
          {busy ? "Syncing…" : "Sync now"}
        </Button>
        {status.complete ? (
          <Button variant="quiet" onClick={onDismiss}>
            Skip for now
          </Button>
        ) : null}
      </div>
    </div>
  );
}
