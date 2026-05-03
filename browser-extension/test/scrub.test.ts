// Browser-side runner for the shared scrub fixture
// `../../test/fixtures/scrub-cases.json`. Same cases as the host runner.

import { describe, test, expect } from "vitest";
import fixture from "../../test/fixtures/scrub-cases.json" with { type: "json" };
import { scrubBody, scrubHeaders } from "../src/capture/scrub.js";

describe("scrubHeaders", () => {
  for (const c of fixture.headerCases) {
    test(c.name, () => {
      expect(scrubHeaders(c.input as unknown as Record<string, string>)).toEqual(c.expected);
    });
  }
});

describe("scrubBody", () => {
  for (const c of fixture.bodyCases) {
    test(c.name, () => {
      expect(scrubBody(c.input)).toEqual(c.expected);
    });
  }
});
