// MV3 service workers cannot use getUserMedia/MediaRecorder. We open an
// offscreen document — a hidden DOM context — that hosts the recorder
// and posts audio + transcript chunks back over chrome.runtime messages.

const OFFSCREEN_URL = "src/offscreen/recorder.html";

export async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record voice narration accompanying the captured workflow.",
  });
}

export async function closeOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.();
  if (!has) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}
