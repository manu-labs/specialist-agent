// Bundle assembly + schema parse, on the extension side.

import { describe, test, expect } from "vitest";
import fixture from "../../test/fixtures/bundle-example.json" with { type: "json" };
import { BundleSchema } from "../src/bundle/schema.js";
import { buildBundle } from "../src/bundle/build.js";
import type { HttpExchange } from "../src/shared/types.js";

describe("BundleSchema", () => {
  test("parses the shared fixture", () => {
    const parsed = BundleSchema.parse(fixture);
    expect(parsed.har.log.entries).toHaveLength(1);
  });
});

describe("buildBundle", () => {
  test("produces a schema-valid bundle from a single exchange", () => {
    const exchanges: HttpExchange[] = [
      {
        index: 0,
        request: {
          method: "POST",
          url: "https://api.stripe.com/v1/customers",
          headers: { Authorization: "{{auth}}", "Content-Type": "application/x-www-form-urlencoded" },
          body: "email=alice%40acme.com",
          timestamp: "2026-05-02T15:30:11.123Z",
        },
        response: {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { id: "cus_abc" },
          durationMs: 142,
        },
      },
    ];
    const bundle = buildBundle({
      intent: "create a customer",
      exchanges,
      audio: null,
      extensionVersion: "0.1.0",
      browser: "chrome/120",
    });
    expect(() => BundleSchema.parse(bundle)).not.toThrow();
    expect(bundle.har.log.entries).toHaveLength(1);
    expect(bundle.har.log.entries[0]!.request.method).toBe("POST");
  });

  test("hostFilter trims out non-matching hosts", () => {
    const exchanges: HttpExchange[] = [
      mkExchange("https://api.stripe.com/v1/customers"),
      mkExchange("https://www.google-analytics.com/g/collect"),
    ];
    const bundle = buildBundle({
      intent: "x",
      exchanges,
      audio: null,
      hostFilter: (h) => h.endsWith("stripe.com"),
      extensionVersion: "0.1.0",
      browser: "chrome/120",
    });
    expect(bundle.har.log.entries).toHaveLength(1);
    expect(bundle.har.log.entries[0]!.request.url).toContain("stripe.com");
  });
});

function mkExchange(url: string): HttpExchange {
  return {
    index: 0,
    request: { method: "GET", url, headers: {}, body: null, timestamp: new Date().toISOString() },
    response: { status: 200, headers: {}, body: null, durationMs: 1 },
  };
}
