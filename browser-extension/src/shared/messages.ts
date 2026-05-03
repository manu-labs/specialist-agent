import type { BundleSummary, CaptureStats, ErrorCode } from "./types.js";
import type { ExtensionConfig } from "./config.js";

export type SubmitResult =
  | { kind: "posted"; status: number; traceId?: string; learnUrl?: string }
  | { kind: "downloaded"; filename: string; bytes: number; reason: "no_endpoint" | "post_failed"; postError?: string }
  | { kind: "failed"; errorCode: string; detail: string };

export type ClientMessage =
  | { type: "POPUP_TO_BG_START_RECORDING"; tabId: number; recordAudio: boolean }
  | { type: "POPUP_TO_BG_STOP_RECORDING" }
  | { type: "POPUP_TO_BG_GET_SNAPSHOT" }
  | { type: "POPUP_TO_BG_UPDATE_INTENT"; intent: string; narrative?: string }
  | { type: "POPUP_TO_BG_FILTER_HOST"; hostPattern: string | null }
  | { type: "POPUP_TO_BG_BUILD_BUNDLE"; includeAudio: boolean }
  | { type: "POPUP_TO_BG_DOWNLOAD_FALLBACK" }
  | { type: "POPUP_TO_BG_RETRY_SUBMIT" }
  | { type: "POPUP_TO_BG_DISCARD" }
  | { type: "OPTIONS_TO_BG_SET_CONFIG"; config: ExtensionConfig }
  | { type: "OFFSCREEN_TO_BG_AUDIO_CHUNK"; chunk: ArrayBuffer; mimeType: string }
  | { type: "OFFSCREEN_TO_BG_TRANSCRIPT_PARTIAL"; text: string; isFinal: boolean }
  | { type: "OFFSCREEN_TO_BG_RECORDING_STOPPED"; finalAudio: ArrayBuffer | null; mimeType: string; durationMs: number };

export type ServerMessage =
  | { type: "BG_TO_POPUP_CAPTURE_STATS"; stats: CaptureStats }
  | { type: "BG_TO_POPUP_BUNDLE_READY"; bundle: BundleSummary }
  | { type: "BG_TO_POPUP_SUBMIT_RESULT"; result: SubmitResult }
  | { type: "BG_TO_POPUP_SUBMIT_PENDING" }
  | { type: "BG_TO_POPUP_TRANSCRIPT"; intent: string; narrative: string }
  | { type: "BG_TO_POPUP_ERROR"; code: ErrorCode; detail: string }
  | { type: "BG_TO_OFFSCREEN_START_RECORDING"; mimeType: string; transcriber: "webspeech" | "whisper-wasm" }
  | { type: "BG_TO_OFFSCREEN_STOP_RECORDING" }
  | { type: "BG_TO_CONTENT_SHOW_BANNER"; state: "recording" | "stopped" };

export const POPUP_STATS_PORT = "popup-stats";
