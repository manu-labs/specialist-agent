// CaptureAdapter abstracts the capture mechanism so v1.1 can swap in a
// Firefox `webRequest.filterResponseData`-based implementation without
// touching the rest of the background pipeline.

import type { HttpExchange } from "../../shared/types.js";

export interface CaptureAdapter {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  onExchange(cb: (exchange: Omit<HttpExchange, "index">) => void): void;
  onError(cb: (e: { code: string; detail: string }) => void): void;
  onNavigation(cb: (url: string) => void): void;
}
