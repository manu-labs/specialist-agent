// Pending-exchange state machine. Folds the stream of CDP events into
// completed `HttpExchange` records. Pure logic, no chrome.* calls — that
// makes it trivially unit-testable from a recorded JSONL fixture.

import type { HttpExchange } from "../../shared/types.js";
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

interface PendingExchange {
  requestId: string;
  startedAt: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    timestamp: string;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    mimeType: string;
    durationMs: number;
  };
  startTimestamp: number;
  bytesReceived: number;
}

export interface ReconstructorOptions {
  bodyMaxBytes: number;
  /**
   * Async getter for the response body. Wraps
   * `chrome.debugger.sendCommand("Network.getResponseBody", ...)`.
   * Returns null if the body is not available (e.g. failed request).
   */
  getResponseBody: (requestId: string) => Promise<GetResponseBodyResult | null>;
  onExchange: (exchange: Omit<HttpExchange, "index">) => void;
  onError?: (e: { code: string; detail: string }) => void;
}

const RACE_BUFFER_MS = 50;

export class CdpReconstructor {
  private pending = new Map<string, PendingExchange>();
  private extraReqInfo = new Map<string, RequestWillBeSentExtraInfo>();
  private extraResInfo = new Map<string, ResponseReceivedExtraInfo>();

  constructor(private readonly opts: ReconstructorOptions) {}

  onRequestWillBeSent(ev: RequestWillBeSent): void {
    if (ev.redirectResponse) {
      const prior = this.pending.get(ev.requestId);
      if (prior) {
        prior.response = {
          status: ev.redirectResponse.status,
          headers: { ...ev.redirectResponse.headers },
          mimeType: ev.redirectResponse.mimeType,
          durationMs: Math.max(0, (ev.timestamp - prior.startTimestamp) * 1000),
        };
        this.opts.onExchange({
          request: prior.request,
          response: {
            status: prior.response.status,
            headers: prior.response.headers,
            body: null,
            durationMs: prior.response.durationMs,
          },
        });
      }
      this.pending.delete(ev.requestId);
    }

    const merged = mergeHeaders(ev.request.headers, this.extraReqInfo.get(ev.requestId)?.headers);
    this.extraReqInfo.delete(ev.requestId);

    this.pending.set(ev.requestId, {
      requestId: ev.requestId,
      startedAt: new Date(ev.wallTime * 1000).toISOString(),
      startTimestamp: ev.timestamp,
      bytesReceived: 0,
      request: {
        method: ev.request.method.toUpperCase(),
        url: ev.request.url,
        headers: merged,
        body: parseRequestBody(ev.request.postData, merged),
        timestamp: new Date(ev.wallTime * 1000).toISOString(),
      },
    });
  }

  onRequestWillBeSentExtraInfo(ev: RequestWillBeSentExtraInfo): void {
    const pending = this.pending.get(ev.requestId);
    if (pending) {
      pending.request.headers = mergeHeaders(pending.request.headers, ev.headers);
    } else {
      this.extraReqInfo.set(ev.requestId, ev);
      setTimeout(() => this.extraReqInfo.delete(ev.requestId), RACE_BUFFER_MS);
    }
  }

  onResponseReceived(ev: ResponseReceived): void {
    const pending = this.pending.get(ev.requestId);
    if (!pending) return;
    const merged = mergeHeaders(ev.response.headers, this.extraResInfo.get(ev.requestId)?.headers);
    this.extraResInfo.delete(ev.requestId);
    pending.response = {
      status: ev.response.status,
      headers: merged,
      mimeType: ev.response.mimeType,
      durationMs: Math.max(0, (ev.timestamp - pending.startTimestamp) * 1000),
    };
  }

  onResponseReceivedExtraInfo(ev: ResponseReceivedExtraInfo): void {
    const pending = this.pending.get(ev.requestId);
    if (pending?.response) {
      pending.response.headers = mergeHeaders(pending.response.headers, ev.headers);
    } else {
      this.extraResInfo.set(ev.requestId, ev);
      setTimeout(() => this.extraResInfo.delete(ev.requestId), RACE_BUFFER_MS);
    }
  }

  onDataReceived(ev: DataReceived): void {
    const pending = this.pending.get(ev.requestId);
    if (pending) pending.bytesReceived += ev.encodedDataLength || ev.dataLength;
  }

  async onLoadingFinished(ev: LoadingFinished): Promise<void> {
    const pending = this.pending.get(ev.requestId);
    if (!pending || !pending.response) {
      this.pending.delete(ev.requestId);
      return;
    }

    let body: unknown = null;
    try {
      const result = await this.opts.getResponseBody(ev.requestId);
      if (result) {
        body = decodeBody(result, pending.response.mimeType, this.opts.bodyMaxBytes);
      }
    } catch (err) {
      this.opts.onError?.({
        code: "get_response_body_failed",
        detail: (err as Error).message,
      });
    }

    pending.response.durationMs = Math.max(0, (ev.timestamp - pending.startTimestamp) * 1000);
    this.opts.onExchange({
      request: pending.request,
      response: {
        status: pending.response.status,
        headers: pending.response.headers,
        body,
        durationMs: pending.response.durationMs,
      },
    });
    this.pending.delete(ev.requestId);
  }

  onLoadingFailed(ev: LoadingFailed): void {
    const pending = this.pending.get(ev.requestId);
    if (!pending) return;
    this.opts.onExchange({
      request: pending.request,
      response: {
        status: 0,
        headers: { "x-extension-error": ev.errorText || "loading_failed" },
        body: null,
        durationMs: Math.max(0, (ev.timestamp - pending.startTimestamp) * 1000),
      },
    });
    this.pending.delete(ev.requestId);
  }

  /**
   * Synthesize a navigation boundary so post-hoc readers can spot when
   * the active tab navigated mid-capture.
   */
  emitNavigationBoundary(url: string): void {
    this.opts.onExchange({
      request: {
        method: "NAVIGATE",
        url,
        headers: {},
        body: null,
        timestamp: new Date().toISOString(),
      },
      response: {
        status: 0,
        headers: {},
        body: null,
        durationMs: 0,
      },
    });
  }

  reset(): void {
    this.pending.clear();
    this.extraReqInfo.clear();
    this.extraResInfo.clear();
  }
}

function mergeHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  if (!extra) return { ...base };
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

function parseRequestBody(postData: string | undefined, headers: Record<string, string>): unknown {
  if (!postData) return null;
  const ct = lookupHeader(headers, "content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(postData);
    } catch {
      return postData;
    }
  }
  return postData;
}

function lookupHeader(h: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

interface BinaryMarker {
  __binary: true;
  mediaType: string;
  length: number;
}

function decodeBody(
  result: GetResponseBodyResult,
  mimeType: string,
  bodyMaxBytes: number,
): unknown {
  const { body, base64Encoded } = result;
  if (base64Encoded && !looksTextual(mimeType)) {
    const length = Math.floor((body.length * 3) / 4);
    const marker: BinaryMarker = { __binary: true, mediaType: mimeType, length };
    return marker;
  }

  let text = base64Encoded ? safeAtob(body) : body;
  if (text.length > bodyMaxBytes) {
    text = text.slice(0, bodyMaxBytes);
    if (mimeType.includes("application/json")) {
      return { _truncated: true, _preview: text.slice(0, 1024) };
    }
    return text + "\n[_truncated: true]";
  }

  if (mimeType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function looksTextual(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return (
    m.startsWith("text/") ||
    m.includes("json") ||
    m.includes("xml") ||
    m.includes("javascript") ||
    m.includes("x-www-form-urlencoded") ||
    m.includes("event-stream")
  );
}

function safeAtob(s: string): string {
  try {
    return atob(s);
  } catch {
    return "";
  }
}
