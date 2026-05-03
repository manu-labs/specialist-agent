// Single-place dispatch for chrome.runtime.sendMessage. Keeping this in
// one file means popup, options, and offscreen all see the same wire
// shape via `ClientMessage`.
//
// Auto-submit policy: when the user clicks Stop, the bundle is built
// and POSTed to the configured backend. If no endpoint is configured or
// the POST fails, the bundle falls back to a local download so no
// recording is ever silently dropped on the floor.

import { loadConfig, saveConfig, type ExtensionConfig } from "../shared/config.js";
import type { ClientMessage, ServerMessage, SubmitResult } from "../shared/messages.js";
import { POPUP_STATS_PORT } from "../shared/messages.js";
import { logger } from "../shared/logger.js";
import type { CaptureSessionRunner } from "./session.js";
import { ensureOffscreen, closeOffscreen } from "./offscreen-control.js";
import { submitDownload } from "../bundle/submit-download.js";
import { submitPost } from "../bundle/submit-post.js";
import type { Bundle } from "../bundle/schema.js";

const AUDIO_FINALIZE_TIMEOUT_MS = 5_000;

export interface RouterDeps {
  getSession: () => CaptureSessionRunner | null;
  setSession: (s: CaptureSessionRunner | null) => void;
  createSession: (tabId: number, recordAudio: boolean) => Promise<CaptureSessionRunner>;
}

let lastSubmitResult: SubmitResult | null = null;
let lastBuiltBundle: Bundle | null = null;

const popupPorts = new Set<chrome.runtime.Port>();

function broadcastToPopup(m: ServerMessage): void {
  for (const port of popupPorts) {
    try {
      port.postMessage(m);
    } catch {
      /* port closed */
    }
  }
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
    popupPorts.add(port);
    const session = deps.getSession();
    if (session) {
      port.postMessage({ type: "BG_TO_POPUP_CAPTURE_STATS", stats: session.snapshot() } satisfies ServerMessage);
      session.setEvents({
        onStats: (stats) => broadcastToPopup({ type: "BG_TO_POPUP_CAPTURE_STATS", stats }),
        onError: (e) => broadcastToPopup({ type: "BG_TO_POPUP_ERROR", code: e.code as never, detail: e.detail }),
      });
    }
    if (lastSubmitResult) {
      port.postMessage({ type: "BG_TO_POPUP_SUBMIT_RESULT", result: lastSubmitResult } satisfies ServerMessage);
    }
    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
      const s = deps.getSession();
      if (popupPorts.size === 0) s?.setEvents({});
    });
  });
}

async function handle(msg: ClientMessage, deps: RouterDeps): Promise<unknown> {
  switch (msg.type) {
    case "POPUP_TO_BG_START_RECORDING": {
      if (deps.getSession()) throw new Error("a recording is already in progress");
      lastSubmitResult = null;
      lastBuiltBundle = null;
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

      const audioWait = session.opts.recordAudio ? session.awaitAudio(AUDIO_FINALIZE_TIMEOUT_MS) : Promise.resolve();
      await chrome.runtime
        .sendMessage({ type: "BG_TO_OFFSCREEN_STOP_RECORDING" } satisfies ServerMessage)
        .catch(() => {
          /* offscreen may not be open if recordAudio was false */
        });
      await session.stop();
      await audioWait;

      broadcastToPopup({ type: "BG_TO_POPUP_SUBMIT_PENDING" });
      const cfg = await loadConfig();
      const bundle = session.buildBundle(true);
      lastBuiltBundle = bundle;
      const result = await autoSubmit(bundle, cfg);
      lastSubmitResult = result;
      broadcastToPopup({ type: "BG_TO_POPUP_SUBMIT_RESULT", result });
      return { ok: true, result, stats: session.snapshot() };
    }
    case "POPUP_TO_BG_GET_SNAPSHOT": {
      const session = deps.getSession();
      if (!session) {
        return { active: false, lastSubmitResult };
      }
      return {
        active: true,
        stats: session.snapshot(),
        intent: session.intentText(),
        narrative: session.narrativeText(),
        lastSubmitResult,
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
    case "POPUP_TO_BG_DOWNLOAD_FALLBACK": {
      const bundle = lastBuiltBundle ?? deps.getSession()?.buildBundle(true);
      if (!bundle) throw new Error("no bundle available — start a new recording");
      const dl = await submitDownload(bundle);
      const result: SubmitResult = {
        kind: "downloaded",
        filename: dl.filename,
        bytes: dl.bytes,
        reason: "post_failed",
      };
      lastSubmitResult = result;
      broadcastToPopup({ type: "BG_TO_POPUP_SUBMIT_RESULT", result });
      return { ok: true, result };
    }
    case "POPUP_TO_BG_RETRY_SUBMIT": {
      const bundle = lastBuiltBundle ?? deps.getSession()?.buildBundle(true);
      if (!bundle) throw new Error("no bundle available — start a new recording");
      broadcastToPopup({ type: "BG_TO_POPUP_SUBMIT_PENDING" });
      const cfg = await loadConfig();
      const result = await autoSubmit(bundle, cfg);
      lastSubmitResult = result;
      broadcastToPopup({ type: "BG_TO_POPUP_SUBMIT_RESULT", result });
      return { ok: true, result };
    }
    case "POPUP_TO_BG_DISCARD": {
      const session = deps.getSession();
      if (session) await session.discard();
      deps.setSession(null);
      lastSubmitResult = null;
      lastBuiltBundle = null;
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
      if (!session) {
        await closeOffscreen();
        return { ok: true };
      }
      if (msg.finalAudio) {
        session.setAudio({
          mimeType: msg.mimeType,
          bytes: msg.finalAudio,
          durationMs: msg.durationMs,
        });
      } else {
        // Resolve the wait even if no audio came back, so stop doesn't hang.
        session.setAudio(null);
      }
      await closeOffscreen();
      return { ok: true };
    }
    default:
      throw new Error(`unknown message type: ${(msg as { type: string }).type}`);
  }
}

/**
 * Submit a bundle. Default path: POST to the configured endpoint. If no
 * endpoint is configured, fall through to a local download. If the POST
 * fails for any reason (network, 4xx, 5xx), still write a local
 * download so the user never silently loses a recording.
 */
async function autoSubmit(bundle: Bundle, cfg: ExtensionConfig): Promise<SubmitResult> {
  if (!cfg.postEndpoint) {
    try {
      const dl = await submitDownload(bundle);
      return { kind: "downloaded", filename: dl.filename, bytes: dl.bytes, reason: "no_endpoint" };
    } catch (err) {
      return { kind: "failed", errorCode: "download_failed", detail: (err as Error).message };
    }
  }

  const post = await submitPost(bundle, cfg);
  if (post.ok) {
    const result: SubmitResult = { kind: "posted", status: post.status };
    if (post.traceId) result.traceId = post.traceId;
    if (post.learnUrl) result.learnUrl = post.learnUrl;
    return result;
  }

  // POST failed — fall back to download so the recording is never lost.
  try {
    const dl = await submitDownload(bundle);
    return {
      kind: "downloaded",
      filename: dl.filename,
      bytes: dl.bytes,
      reason: "post_failed",
      postError: `${post.errorCode}: ${post.detail}`,
    };
  } catch {
    return { kind: "failed", errorCode: post.errorCode, detail: post.detail };
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
