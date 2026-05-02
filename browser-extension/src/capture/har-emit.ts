// Convert an HttpExchange[] into HAR 1.2. The shape emitted here is a
// strict subset of what the host's `importHar` reads (see
// `src/capture/har.ts`). Bodies are always serialized as strings inside
// `content.text` / `postData.text`; binary payloads are emitted as a
// JSON-stringified marker so the existing parser keeps working.

import type { HttpExchange } from "../shared/types.js";

export interface HarFile {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    browser?: { name: string; version: string };
    entries: HarEntry[];
  };
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarHeader[];
    cookies: HarHeader[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: HarHeader[];
    headersSize: number;
    bodySize: number;
    redirectURL: string;
    content: { mimeType: string; text: string; size: number };
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

interface HarHeader {
  name: string;
  value: string;
}

export interface HarEmitOptions {
  creator?: { name: string; version: string };
  browser?: { name: string; version: string };
}

const DEFAULT_CREATOR = { name: "specialist-extension", version: "0.1.0" };

export function emitHar(exchanges: HttpExchange[], opts: HarEmitOptions = {}): HarFile {
  return {
    log: {
      version: "1.2",
      creator: opts.creator ?? DEFAULT_CREATOR,
      ...(opts.browser ? { browser: opts.browser } : {}),
      entries: exchanges.map(exchangeToEntry),
    },
  };
}

function exchangeToEntry(e: HttpExchange): HarEntry {
  const reqMime = headerValue(e.request.headers, "content-type") ?? "";
  const respMime = headerValue(e.response.headers, "content-type") ?? "application/octet-stream";

  return {
    startedDateTime: e.request.timestamp,
    time: Math.max(0, e.response.durationMs),
    request: {
      method: e.request.method.toUpperCase(),
      url: e.request.url,
      httpVersion: "HTTP/1.1",
      headers: objectToHarHeaders(e.request.headers),
      queryString: extractQueryString(e.request.url),
      cookies: [],
      headersSize: -1,
      bodySize: e.request.body == null ? 0 : -1,
      ...(e.request.body == null ? {} : { postData: { mimeType: reqMime, text: bodyToText(e.request.body) } }),
    },
    response: {
      status: e.response.status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: objectToHarHeaders(e.response.headers),
      cookies: [],
      headersSize: -1,
      bodySize: -1,
      redirectURL: "",
      content: {
        mimeType: respMime,
        text: bodyToText(e.response.body),
        size: -1,
      },
    },
    cache: {},
    timings: { send: 0, wait: e.response.durationMs, receive: 0 },
  };
}

function objectToHarHeaders(h: Record<string, string>): HarHeader[] {
  return Object.entries(h).map(([name, value]) => ({ name, value }));
}

function headerValue(h: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function extractQueryString(url: string): HarHeader[] {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function bodyToText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}
