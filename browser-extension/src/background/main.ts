// Service worker entry. Activated on user interaction (popup click,
// installation, debugger event). Owns one CaptureSessionRunner at a
// time; the router is the single dispatch surface.

import { loadConfig, DEFAULT_CONFIG } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { installRouter } from "./router.js";
import { CaptureSessionRunner } from "./session.js";
import { loadCapture } from "./storage.js";

let session: CaptureSessionRunner | null = null;

const VERSION = chrome.runtime.getManifest().version;

installRouter({
  getSession: () => session,
  setSession: (s) => {
    session = s;
  },
  createSession: async (tabId, _recordAudio) => {
    const cfg = await loadConfig().catch(() => DEFAULT_CONFIG);
    let tabUrl: string | undefined;
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url;
    } catch {
      /* tab may be gone */
    }
    return new CaptureSessionRunner(
      {
        tabId,
        ...(tabUrl ? { tabUrl } : {}),
        recordAudio: _recordAudio,
        bodyMaxBytes: cfg.bodyMaxBytes,
        hostFilterMode: cfg.hostFilterMode,
        hostAllowlist: cfg.hostAllowlist,
        extensionVersion: VERSION,
        browser: detectBrowser(),
      },
      {},
    );
  },
});

chrome.runtime.onInstalled.addListener(() => {
  logger.info("specialist-extension installed", VERSION);
});

chrome.runtime.onStartup.addListener(async () => {
  const persisted = await loadCapture();
  if (persisted) {
    logger.warn("found persisted capture from a previous session — discarding (rehydrate is v1.1)");
  }
});

function detectBrowser(): string {
  const ua = navigator.userAgent;
  const m = ua.match(/Chrom[ei]\w+\/(\d+)/);
  if (m) return `chrome/${m[1]}`;
  return "chrome/unknown";
}
