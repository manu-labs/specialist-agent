// Round-trip: HttpExchange[] → emitHar → JSON → re-parse → confirm the
// shape matches what the host's importHar (HAR 1.2) expects.

import { describe, test, expect } from "vitest";
import { emitHar } from "../src/capture/har-emit.js";
import type { HttpExchange } from "../src/shared/types.js";

const sample: HttpExchange = {
  index: 0,
  request: {
    method: "POST",
    url: "https://api.stripe.com/v1/customers?expand[]=invoice",
    headers: { Authorization: "{{auth}}", "Content-Type": "application/json" },
    body: { email: "alice@acme.com" },
    timestamp: "2026-05-02T15:30:11.123Z",
  },
  response: {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: { id: "cus_abc" },
    durationMs: 142,
  },
};

describe("emitHar", () => {
  test("emits HAR 1.2 with creator info", () => {
    const har = emitHar([sample]);
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("specialist-extension");
    expect(har.log.entries).toHaveLength(1);
  });

  test("queryString is extracted from URL", () => {
    const har = emitHar([sample]);
    expect(har.log.entries[0]!.request.queryString).toEqual([{ name: "expand[]", value: "invoice" }]);
  });

  test("postData/text is JSON-stringified", () => {
    const har = emitHar([sample]);
    expect(har.log.entries[0]!.request.postData?.text).toBe('{"email":"alice@acme.com"}');
  });

  test("response content.text is JSON-stringified", () => {
    const har = emitHar([sample]);
    expect(har.log.entries[0]!.response.content.text).toBe('{"id":"cus_abc"}');
  });

  test("string body is preserved verbatim", () => {
    const x: HttpExchange = {
      ...sample,
      request: { ...sample.request, body: "raw=text&other=value", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    };
    const har = emitHar([x]);
    expect(har.log.entries[0]!.request.postData?.text).toBe("raw=text&other=value");
  });
});
