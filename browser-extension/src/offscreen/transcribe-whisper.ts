// Whisper-tiny (~30MB WASM) fallback for Firefox or "transcribe locally"
// opt-in on Chrome. The WASM binary is lazy-loaded from /vendor on first
// use so the base extension stays small.
//
// v1: stub interface only — wiring the actual WASM module is gated on
// shipping the vendor file, which is tracked separately (see plan §4.1
// + .gitignore).

export interface WhisperHandle {
  pushPcm(samples: Float32Array): void;
  finalize(): Promise<string>;
}

export async function startWhisper(): Promise<WhisperHandle> {
  // Intentional: the vendor file is added by an out-of-band tool. If it
  // ever lands, this loader is the single touchpoint.
  throw new Error("whisper-wasm transcriber is not bundled in this build");
}
