import type { ReactNode } from "react";

import type { ChangeAction, CommitChange } from "./api";
import { ACTION_SIGN, pathLabel } from "./format";

/**
 * Non-blocking failure notice. The surrounding view keeps whatever data it
 * already had, so this reports staleness rather than replacing content.
 */
export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <div class="banner" role="status">
      <svg class="banner-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.6 15 14H1L8 1.6Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
        <path d="M8 6v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="8" cy="12" r="0.9" fill="currentColor" />
      </svg>
      <span class="banner-text">{message}</span>
      {onRetry ? (
        <button class="banner-action" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Placeholder bars shown while a first load is in flight. */
export function Skeleton({ lines = 3, class: extra }: { lines?: number; class?: string }) {
  return (
    <div class={extra ? `skeleton ${extra}` : "skeleton"} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div class="skeleton-line" key={index} style={{ width: `${100 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children ? <div class="empty-body">{children}</div> : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  class: extra,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  class?: string;
}) {
  return (
    <section class={extra ? `card ${extra}` : "card"}>
      {title !== undefined ? (
        <header class="card-head">
          <h2 class="card-title">{title}</h2>
          {actions ? <div class="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div class="card-body">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" }) {
  return (
    <div class={tone === "warn" ? "stat stat-warn" : "stat"}>
      <span class="stat-label">{label}</span>
      <span class="stat-value">{value}</span>
    </div>
  );
}

/** `+ skill deploy`, `~ page team/oncall`, `− skill legacy`. */
export function ChangeChip({ change }: { change: CommitChange }) {
  return (
    <span class={`chip chip-${change.action}`} title={`${change.action} ${change.kind}`}>
      <span class="chip-sign">{ACTION_SIGN[change.action]}</span>
      <span class="chip-kind">{change.kind}</span>
      <span class="chip-name">{change.name}</span>
    </span>
  );
}

export function NameChip({
  action,
  kind,
  name,
}: {
  action: ChangeAction;
  kind: "skill" | "page";
  name: string;
}) {
  return <ChangeChip change={{ action, kind, name }} />;
}

export function PathChip({ path }: { path: string }) {
  return <span class="path-chip" title={path}>{pathLabel(path)}</span>;
}

/**
 * The app's only button style, in three weights. Everything that submits,
 * advances or dismisses uses this, so a new surface cannot introduce a fourth
 * kind of button by accident.
 */
export function Button({
  children,
  onClick,
  variant = "secondary",
  type = "button",
  disabled,
  busy,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "quiet";
  type?: "button" | "submit";
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      class={`btn btn-${variant}`}
      type={type}
      onClick={onClick}
      // A busy button stays disabled so a slow route cannot be submitted twice,
      // and `aria-busy` tells a screen reader why it stopped responding.
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
    >
      {children}
    </button>
  );
}

/**
 * A labelled text input with room for a hint and an error.
 *
 * The hint is tied to the input with `aria-describedby` rather than left as
 * loose text, because the hints here carry the instructions — what a URL should
 * look like, which scopes a token needs — and a screen reader that skips them
 * loses the part of the form that explains it.
 */
export function Field({
  id,
  label,
  value,
  onInput,
  type = "text",
  placeholder,
  hint,
  error,
  autocomplete,
}: {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  type?: "text" | "password" | "email";
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  autocomplete?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div class="field">
      <label class="field-label" for={id}>
        {label}
      </label>
      <input
        class={error ? "field-input field-input-bad" : "field-input"}
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autocomplete={autocomplete}
        aria-describedby={describedBy}
        aria-invalid={error ? "true" : undefined}
        onInput={(event) => onInput((event.target as HTMLInputElement).value)}
      />
      {hint ? (
        <p class="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p class="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
