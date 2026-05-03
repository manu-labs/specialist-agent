// Hosts MediaRecorder + the chosen transcriber. The service worker
// drives lifecycle via BG_TO_OFFSCREEN_* messages; this file replies
// with OFFSCREEN_TO_BG_* messages.

import type { ClientMessage, ServerMessage } from "../shared/messages.js";
import { startWebSpeech, type WebSpeechHandle } from "./transcribe-webspeech.js";

interface RuntimeState {
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: BlobPart[];
  startedAt: number;
  speech: WebSpeechHandle | null;
  mimeType: string;
}

const state: RuntimeState = {
  recorder: null,
  stream: null,
  chunks: [],
  startedAt: 0,
  speech: null,
  mimeType: "audio/webm;codecs=opus",
};

chrome.runtime.onMessage.addListener((msg: ServerMessage, _sender, sendResponse) => {
  void handle(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
  return true;
});

async function handle(msg: ServerMessage): Promise<unknown> {
  switch (msg.type) {
    case "BG_TO_OFFSCREEN_START_RECORDING":
      return start(msg.mimeType, msg.transcriber);
    case "BG_TO_OFFSCREEN_STOP_RECORDING":
      return stop();
    default:
      return { ok: false, error: `unhandled in offscreen: ${msg.type}` };
  }
}

async function start(mimeType: string, transcriber: "webspeech" | "whisper-wasm"): Promise<unknown> {
  if (state.recorder) return { ok: false, error: "already recording" };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return { ok: false, error: `media_permission: ${(err as Error).message}` };
  }
  const recorder = new MediaRecorder(stream, {
    mimeType,
    audioBitsPerSecond: 32_000,
  });
  state.recorder = recorder;
  state.stream = stream;
  state.chunks = [];
  state.startedAt = Date.now();
  state.mimeType = mimeType;

  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) state.chunks.push(ev.data);
  };
  recorder.start(1000);

  if (transcriber === "webspeech") {
    state.speech = startWebSpeech((text, isFinal) => {
      const out: ClientMessage = { type: "OFFSCREEN_TO_BG_TRANSCRIPT_PARTIAL", text, isFinal };
      void chrome.runtime.sendMessage(out);
    });
  }
  return { ok: true };
}

async function stop(): Promise<unknown> {
  const recorder = state.recorder;
  if (!recorder) return { ok: false, error: "not recording" };
  state.speech?.stop();
  state.speech = null;

  const finalAudio = await new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(state.chunks, { type: state.mimeType }));
    recorder.stop();
  });
  state.stream?.getTracks().forEach((t) => t.stop());

  const buffer = await finalAudio.arrayBuffer();
  const out: ClientMessage = {
    type: "OFFSCREEN_TO_BG_RECORDING_STOPPED",
    finalAudio: buffer,
    mimeType: state.mimeType,
    durationMs: Date.now() - state.startedAt,
  };
  await chrome.runtime.sendMessage(out);

  state.recorder = null;
  state.stream = null;
  state.chunks = [];
  return { ok: true };
}
