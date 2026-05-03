// chrome.storage.session is a session-scoped, in-memory key/value store
// (not persisted to disk). We checkpoint capture state here so that if
// the service worker gets evicted mid-capture, we can rehydrate on wake.

import type { HttpExchange } from "../shared/types.js";

const CAPTURE_KEY = "specialist.capture";
const CHECKPOINT_EVERY = 5;

export interface PersistedCapture {
  sessionId: string;
  startedAt: string;
  intent: string;
  narrative: string;
  exchanges: HttpExchange[];
  audio: { mimeType: string; base64: string; durationMs: number } | null;
  hostFilter: string | null;
  tabId: number | null;
  tabUrl: string | null;
}

let pendingWrites = 0;

export async function persistCapture(state: PersistedCapture, force = false): Promise<void> {
  pendingWrites++;
  if (!force && pendingWrites % CHECKPOINT_EVERY !== 0) return;
  await chrome.storage.session.set({ [CAPTURE_KEY]: state });
}

export async function loadCapture(): Promise<PersistedCapture | null> {
  const raw = await chrome.storage.session.get(CAPTURE_KEY);
  return (raw[CAPTURE_KEY] as PersistedCapture | undefined) ?? null;
}

export async function clearCapture(): Promise<void> {
  pendingWrites = 0;
  await chrome.storage.session.remove(CAPTURE_KEY);
}
