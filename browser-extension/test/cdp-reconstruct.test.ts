// Replay a recorded CDP event sequence into the reconstructor and
// assert the resulting HttpExchange[] matches expectations.

import { describe, test, expect } from "vitest";
import { CdpReconstructor } from "../src/background/cdp/reconstruct.js";
import type { HttpExchange } from "../src/shared/types.js";

describe("CdpReconstructor", () => {
  test("single GET — request → response → loadingFinished", async () => {
    const exchanges: Omit<HttpExchange, "index">[] = [];
    const r = new CdpReconstructor({
      bodyMaxBytes: 1024,
      getResponseBody: async () => ({ body: '{"ok":true}', base64Encoded: false }),
      onExchange: (e) => exchanges.push(e),
    });
    r.onRequestWillBeSent({
      requestId: "1",
      loaderId: "L",
      documentURL: "https://example.com",
      timestamp: 1.0,
      wallTime: 1700000000,
      request: {
        method: "GET",
        url: "https://example.com/api",
        headers: { Accept: "application/json" },
      },
    });
    r.onResponseReceived({
      requestId: "1",
      loaderId: "L",
      timestamp: 1.05,
      type: "XHR",
      response: {
        url: "https://example.com/api",
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
        mimeType: "application/json",
      },
    });
    await r.onLoadingFinished({ requestId: "1", timestamp: 1.1, encodedDataLength: 11 });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.request.method).toBe("GET");
    expect(exchanges[0]!.response.status).toBe(200);
    expect(exchanges[0]!.response.body).toEqual({ ok: true });
  });

  test("redirect emits two exchanges with the same requestId", async () => {
    const exchanges: Omit<HttpExchange, "index">[] = [];
    const r = new CdpReconstructor({
      bodyMaxBytes: 1024,
      getResponseBody: async () => ({ body: "ok", base64Encoded: false }),
      onExchange: (e) => exchanges.push(e),
    });
    r.onRequestWillBeSent({
      requestId: "1",
      loaderId: "L",
      documentURL: "https://example.com",
      timestamp: 1.0,
      wallTime: 1700000000,
      request: { method: "GET", url: "https://example.com/old", headers: {} },
    });
    r.onRequestWillBeSent({
      requestId: "1",
      loaderId: "L",
      documentURL: "https://example.com",
      timestamp: 1.05,
      wallTime: 1700000000,
      request: { method: "GET", url: "https://example.com/new", headers: {} },
      redirectResponse: {
        url: "https://example.com/old",
        status: 301,
        statusText: "Moved",
        headers: { Location: "/new" },
        mimeType: "text/html",
      },
    });
    r.onResponseReceived({
      requestId: "1",
      loaderId: "L",
      timestamp: 1.1,
      type: "Document",
      response: {
        url: "https://example.com/new",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
    });
    await r.onLoadingFinished({ requestId: "1", timestamp: 1.2, encodedDataLength: 2 });

    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.request.url).toBe("https://example.com/old");
    expect(exchanges[0]!.response.status).toBe(301);
    expect(exchanges[1]!.request.url).toBe("https://example.com/new");
    expect(exchanges[1]!.response.status).toBe(200);
  });

  test("loadingFailed emits a synthetic error exchange", () => {
    const exchanges: Omit<HttpExchange, "index">[] = [];
    const r = new CdpReconstructor({
      bodyMaxBytes: 1024,
      getResponseBody: async () => null,
      onExchange: (e) => exchanges.push(e),
    });
    r.onRequestWillBeSent({
      requestId: "x",
      loaderId: "L",
      documentURL: "https://example.com",
      timestamp: 1.0,
      wallTime: 1700000000,
      request: { method: "GET", url: "https://example.com/dead", headers: {} },
    });
    r.onLoadingFailed({
      requestId: "x",
      timestamp: 1.5,
      type: "XHR",
      errorText: "net::ERR_CONNECTION_RESET",
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.response.status).toBe(0);
    expect(exchanges[0]!.response.headers["x-extension-error"]).toBe("net::ERR_CONNECTION_RESET");
  });

  test("binary response body is replaced with marker, not retained", async () => {
    const exchanges: Omit<HttpExchange, "index">[] = [];
    const r = new CdpReconstructor({
      bodyMaxBytes: 4096,
      getResponseBody: async () => ({ body: btoa("\x00\x01\x02\x03"), base64Encoded: true }),
      onExchange: (e) => exchanges.push(e),
    });
    r.onRequestWillBeSent({
      requestId: "b",
      loaderId: "L",
      documentURL: "https://example.com",
      timestamp: 1.0,
      wallTime: 1700000000,
      request: { method: "GET", url: "https://example.com/img.png", headers: {} },
    });
    r.onResponseReceived({
      requestId: "b",
      loaderId: "L",
      timestamp: 1.05,
      type: "Image",
      response: {
        url: "https://example.com/img.png",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "image/png",
      },
    });
    await r.onLoadingFinished({ requestId: "b", timestamp: 1.1, encodedDataLength: 4 });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.response.body).toMatchObject({ __binary: true, mediaType: "image/png" });
  });
});
