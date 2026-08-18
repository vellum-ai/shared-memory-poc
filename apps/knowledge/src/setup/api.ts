/**
 * Typed client for the setup routes.
 *
 * Shares `requestRoute` with the knowledge client, so the `{ok, ...}` envelope
 * and the error mapping are handled in exactly one place.
 */

import { PLUGIN_PREFIX, requestRoute } from "../api";

const SETUP_PREFIX = `${PLUGIN_PREFIX}/setup`;

export type StepState = "done" | "blocked" | "pending";
export type StepId = "repository" | "access" | "identity" | "sync";
export type Transport = "https" | "ssh" | "other" | "invalid";

export interface SetupStep {
  id: StepId;
  state: StepState;
  detail: string;
}

export interface SetupAuthor {
  name: string;
  email: string;
}

export interface SetupStatus {
  complete: boolean;
  steps: SetupStep[];
  repoUrl: string | null;
  branch: string;
  transport: Transport;
  repoPath: string | null;
  /** The HTTPS form of an SSH remote, when one can be offered. */
  httpsAlternative: string | null;
  author: SetupAuthor | null;
  tokenStored: boolean;
  clonePresent: boolean;
  syncedHead: string | null;
}

export interface StatusResponse {
  status: SetupStatus;
}

export interface CredentialResponse {
  stored: boolean;
  verified: boolean;
  canPush?: boolean;
  code?: string;
  message?: string;
  status: SetupStatus;
}

export interface SyncResponse {
  synced: boolean;
  message?: string;
  status: SetupStatus;
}

export function fetchSetupStatus(): Promise<StatusResponse> {
  return requestRoute<StatusResponse>(`${SETUP_PREFIX}/status`);
}

export function saveSetupConfig(patch: {
  repoUrl?: string;
  branch?: string;
  author?: SetupAuthor;
}): Promise<StatusResponse> {
  return requestRoute<StatusResponse>(`${SETUP_PREFIX}/config`, patch);
}

export function saveSetupToken(token: string): Promise<CredentialResponse> {
  return requestRoute<CredentialResponse>(`${SETUP_PREFIX}/credential`, { token });
}

export function runSetupSync(): Promise<SyncResponse> {
  return requestRoute<SyncResponse>(`${SETUP_PREFIX}/sync`, {});
}

/** The first step that is not done — the one the wizard should open on. */
export function currentStep(status: SetupStatus): StepId {
  const pending = status.steps.find((step) => step.state !== "done");
  return pending?.id ?? "sync";
}
