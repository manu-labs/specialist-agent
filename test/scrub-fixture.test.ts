// Host-side runner for the shared scrub fixture
// `test/fixtures/scrub-cases.json`. The browser-extension copy of
// `scrub.ts` runs the SAME fixture under Vitest. If either drifts, CI
// fails. Uses node:test (built into Node 20+) to avoid adding a new
// dependency to the host package.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scrubBody, scrubHeaders } from "../src/capture/scrub.js";

interface Fixture {
  headerCases: Array<{ name: string; input: Record<string, string>; expected: Record<string, string> }>;
  bodyCases: Array<{ name: string; input: unknown; expected: unknown }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "fixtures", "scrub-cases.json"), "utf8"),
) as Fixture;

for (const c of fixture.headerCases) {
  test(`scrubHeaders: ${c.name}`, () => {
    assert.deepStrictEqual(scrubHeaders(c.input), c.expected);
  });
}

for (const c of fixture.bodyCases) {
  test(`scrubBody: ${c.name}`, () => {
    assert.deepStrictEqual(scrubBody(c.input), c.expected);
  });
}
