// Single-place dispatch for chrome.runtime.sendMessage. Keeping this in
// one file means popup, options, and offscreen all see the same wire
// shape via `ClientMessage`.

import { loadConfig, saveConfig } from "../shared/config.js";
import type { ClientMessage, ServerMessage } from "../shared/messages.js";
import { POPUP_STATS_PORT } from "../shared/messages.js";
import { logger } from "../shared/logger.js";
import type { CaptureSessionRunner } from "./session.js";
import { ensureOffscreen, closeOffscreen } from "./offscreen-control.js";
import { submitDownload } from "../bundle/submit-download.js";
import { submitPost } from "../bundle/submit-post.js";

export interface RouterDeps {
  getSession: () => CaptureSessionRunner | null;
  setSession: (s: CaptureSessionRunner | null) => void;
  createSession: (tabId: number, recordAudio: boolean) => Promise<CaptureSessionRunner>;
}

export function installRouter(deps: RouterDeps): void {
  chrome.runtime.onMessage.addListener((msg: ClientMessage, _sender, sendResponse) => {
    void handle(msg, deps).then(sendResponse).catch((err) => {
      logger.error("router error", err);
      sendResponse({ ok: false, error: (err as Error).message });
    });
    return true;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_STATS_PORT) return;
    const session = deps.getSession();
    const send = (m: ServerMessage) => {
      try {
        port.postMessage(m);
      } catch {
        /* port closed */
      }
    };
    if (session) {
      send({ type: "BG_TO_POPUP_CAPTURE_STATS", stats: session.snapshot() });
      session.setEvents({
        onStats: (stats) => send({ type: "BG_TO_POPUP_CAPTURE_STATS", stats }),
        onError: (e) => send({ type: "BG_TO_POPUP_ERROR", code: e.code as never, detail: e.detail }),
      });
    }
    port.onDisconnect.addListener(() => {
      const s = deps.getSession();
      s?.setEvents({});
    });
  });
}

async function handle(msg: ClientMessage, deps: RouterDeps): Promise<unknown> {
  switch (msg.type) {
    case "POPUP_TO_BG_START_RECORDING": {
      if (deps.getSession()) throw new Error("a recording is already in progress");
      const session = await deps.createSession(msg.tabId, msg.recordAudio);
      deps.setSession(session);
      await session.start();
      if (msg.recordAudio) {
        await ensureOffscreen();
        const cfg = await loadConfig();
        await chrome.runtime.sendMessage({
          type: "BG_TO_OFFSCREEN_START_RECORDING",
          mimeType: "audio/webm;codecs=opus",
          transcriber: cfg.transcriber,
        } satisfies ServerMessage);
      }
      await chrome.scripting
        .executeScript({
          target: { tabId: msg.tabId },
          files: ["src/content/banner.js"],
        })
        .catch(() => {
          /* injection may fail on chrome:// pages — non-fatal */
        });
      return { ok: true, sessionId: session.snapshot().startedAt };
    }
    case "POPUP_TO_BG_STOP_RECORDING": {
      const session = deps.getSession();
      if (!session) throw new Error("no active session");
      await chrome.runtime
        .sendMessage({ type: "BG_TO_OFFSCREEN_STOP_RECORDING" } satisfies ServerMessage)
        .catch(() => {
          /* offscreen may not be open if recordAudio was false */
        });
      await session.stop();
      return { ok: true, stats: session.snapshot() };
    }
    case "POPUP_TO_BG_GET_SNAPSHOT": {
      const session = deps.getSession();
      if (!session) return { active: false };
      return {
        active: true,
        stats: session.snapshot(),
        intent: session.intentText(),
        narrative: session.narrativeText(),
      };
    }
    case "POPUP_TO_BG_UPDATE_INTENT": {
      const session = deps.getSession();
      if (!session) throw new Error("no active session");
      session.setIntent(msg.intent, msg.narrative);
      return { ok: true };
    }
    case "POPUP_TO_BG_FILTER_HOST": {
      const session = deps.getSession();
      if (!session) throw new Error("no active session");
      session.setHostFilter(msg.hostPattern);
      return { ok: true };
    }
    case "POPUP_TO_BG_BUILD_BUNDLE": {
      const session = deps.getSession();
      if (!session) throw new Error("no active session");
      const bundle = session.buildBundle(msg.includeAudio);
      return { ok: true, bundle };
    }
    case "POPUP_TO_BG_SUBMIT_DOWNLOAD": {
      const session = deps.getSession();
      if (!session) throw new Error("no active session");
      const bundle = session.buildBundle(true);
      const result = await submitDownload(bundle);
      return { ok: true, ...result };
    }
    case "POPUP_TO_BG_SUBMIT_POST": {
      const session = deps.getSession();
      if (!session) throw new Error("no active session");
      const bundle = session.buildBundle(true);
      const cfg = await loadConfig();
      const result = await submitPost(bundle, cfg);
      return result;
    }
    case "POPUP_TO_BG_DISCARD": {
      const session = deps.getSession();
      if (session) await session.discard();
      deps.setSession(null);
      await closeOffscreen();
      return { ok: true };
    }
    case "OPTIONS_TO_BG_SET_CONFIG": {
      await saveConfig(msg.config);
      return { ok: true };
    }
    case "OFFSCREEN_TO_BG_AUDIO_CHUNK": {
      // v1: we keep only the final blob, so per-chunk messages are
      // informational. Forward to the popup if it wants a level meter.
      return { ok: true };
    }
    case "OFFSCREEN_TO_BG_TRANSCRIPT_PARTIAL": {
      const session = deps.getSession();
      if (!session) return { ok: true };
      const existing = session.intentText();
      const next = msg.isFinal ? mergeTranscript(existing, msg.text) : existing;
      session.setIntent(next, msg.isFinal ? appendNarrative(session.narrativeText(), msg.text) : session.narrativeText());
      return { ok: true };
    }
    case "OFFSCREEN_TO_BG_RECORDING_STOPPED": {
      const session = deps.getSession();
      if (!session) return { ok: true };
      if (msg.finalAudio) {
        session.setAudio({
          mimeType: msg.mimeType,
          bytes: msg.finalAudio,
          durationMs: msg.durationMs,
        });
      }
      await closeOffscreen();
      return { ok: true };
    }
    default:
      throw new Error(`unknown message type: ${(msg as { type: string }).type}`);
  }
}

function mergeTranscript(existing: string, finalText: string): string {
  if (!existing) return firstSentence(finalText);
  return existing;
}

function appendNarrative(existing: string, chunk: string): string {
  if (!existing) return chunk;
  if (existing.endsWith(chunk)) return existing;
  return `${existing} ${chunk}`.trim();
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  return (m ? m[0] : text).trim().slice(0, 200);
}
