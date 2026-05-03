// Chrome implementation of CaptureAdapter — wires `chrome.debugger`'s
// Network domain through to `CdpReconstructor`.

import { logger } from "../../shared/logger.js";
import type { HttpExchange } from "../../shared/types.js";
import type { CaptureAdapter } from "./adapter.js";
import type {
  DataReceived,
  GetResponseBodyResult,
  LoadingFailed,
  LoadingFinished,
  RequestWillBeSent,
  RequestWillBeSentExtraInfo,
  ResponseReceived,
  ResponseReceivedExtraInfo,
} from "./events.js";
import { CdpReconstructor } from "./reconstruct.js";

const CDP_VERSION = "1.3";

export interface ChromeDebuggerAdapterOptions {
  bodyMaxBytes: number;
}

export class ChromeDebuggerAdapter implements CaptureAdapter {
  private exchangeCb: ((e: Omit<HttpExchange, "index">) => void) | null = null;
  private errorCb: ((e: { code: string; detail: string }) => void) | null = null;
  private navigationCb: ((url: string) => void) | null = null;
  private attachedTabId: number | null = null;
  private reconstructor: CdpReconstructor;
  private detachListener = this.handleDetach.bind(this);
  private eventListener = this.handleEvent.bind(this);
  private navListener: ((details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => void) | null = null;

  constructor(opts: ChromeDebuggerAdapterOptions) {
    this.reconstructor = new CdpReconstructor({
      bodyMaxBytes: opts.bodyMaxBytes,
      getResponseBody: (requestId) => this.getResponseBody(requestId),
      onExchange: (e) => this.exchangeCb?.(e),
      onError: (e) => this.errorCb?.(e),
    });
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId !== null) {
      throw new Error("ChromeDebuggerAdapter already attached");
    }
    this.attachedTabId = tabId;

    chrome.debugger.onEvent.addListener(this.eventListener);
    chrome.debugger.onDetach.addListener(this.detachListener);

    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
    } catch (err) {
      this.attachedTabId = null;
      chrome.debugger.onEvent.removeListener(this.eventListener);
      chrome.debugger.onDetach.removeListener(this.detachListener);
      const detail = (err as Error).message;
      this.errorCb?.({
        code: detail.toLowerCase().includes("devtools") ? "devtools_open" : "cdp_attach_failed",
        detail,
      });
      throw err;
    }
  }

  async detach(tabId: number): Promise<void> {
    if (this.attachedTabId !== tabId) return;
    chrome.debugger.onEvent.removeListener(this.eventListener);
    chrome.debugger.onDetach.removeListener(this.detachListener);
    if (this.navListener && chrome.webNavigation?.onCommitted) {
      chrome.webNavigation.onCommitted.removeListener(this.navListener);
      this.navListener = null;
    }
    try {
      await chrome.debugger.detach({ tabId });
    } catch (err) {
      logger.warn("debugger detach failed", err);
    }
    this.attachedTabId = null;
    this.reconstructor.reset();
  }

  onExchange(cb: (e: Omit<HttpExchange, "index">) => void): void {
    this.exchangeCb = cb;
  }

  onError(cb: (e: { code: string; detail: string }) => void): void {
    this.errorCb = cb;
  }

  onNavigation(cb: (url: string) => void): void {
    this.navigationCb = cb;
    if (this.attachedTabId === null) return;
    if (!chrome.webNavigation?.onCommitted) return;
    const tabId = this.attachedTabId;
    this.navListener = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      this.reconstructor.emitNavigationBoundary(details.url);
      this.navigationCb?.(details.url);
    };
    chrome.webNavigation.onCommitted.addListener(this.navListener);
  }

  private handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId !== this.attachedTabId) return;
    this.errorCb?.({ code: reason === "target_closed" ? "tab_closed" : "cdp_attach_failed", detail: reason });
    this.attachedTabId = null;
    this.reconstructor.reset();
  }

  private handleEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ): void {
    if (source.tabId !== this.attachedTabId) return;
    const p = params as Record<string, unknown> | undefined;
    if (!p) return;
    switch (method) {
      case "Network.requestWillBeSent":
        this.reconstructor.onRequestWillBeSent(p as unknown as RequestWillBeSent);
        break;
      case "Network.requestWillBeSentExtraInfo":
        this.reconstructor.onRequestWillBeSentExtraInfo(p as unknown as RequestWillBeSentExtraInfo);
        break;
      case "Network.responseReceived":
        this.reconstructor.onResponseReceived(p as unknown as ResponseReceived);
        break;
      case "Network.responseReceivedExtraInfo":
        this.reconstructor.onResponseReceivedExtraInfo(p as unknown as ResponseReceivedExtraInfo);
        break;
      case "Network.dataReceived":
        this.reconstructor.onDataReceived(p as unknown as DataReceived);
        break;
      case "Network.loadingFinished":
        void this.reconstructor.onLoadingFinished(p as unknown as LoadingFinished);
        break;
      case "Network.loadingFailed":
        this.reconstructor.onLoadingFailed(p as unknown as LoadingFailed);
        break;
      default:
        break;
    }
  }

  private async getResponseBody(requestId: string): Promise<GetResponseBodyResult | null> {
    if (this.attachedTabId === null) return null;
    try {
      const result = await chrome.debugger.sendCommand(
        { tabId: this.attachedTabId },
        "Network.getResponseBody",
        { requestId },
      );
      return result as GetResponseBodyResult;
    } catch {
      return null;
    }
  }
}
