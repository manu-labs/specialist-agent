// The shared `test/fixtures/bundle-example.json` must parse against the
// host's BundleSchema. The browser-extension copy of BundleSchema
// validates the same fixture in its own test suite.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BundleSchema } from "../src/bundle/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(here, "fixtures", "bundle-example.json"), "utf8");

test("BundleSchema parses the shared fixture", () => {
  const parsed = BundleSchema.parse(JSON.parse(raw));
  assert.equal(parsed.schemaVersion, "1");
  assert.equal(parsed.metadata.capturedBy, "specialist-extension");
  assert.equal(parsed.har.log.entries.length, 1);
});

test("BundleSchema rejects wrong schemaVersion", () => {
  const parsed = JSON.parse(raw);
  parsed.schemaVersion = "2";
  assert.throws(() => BundleSchema.parse(parsed));
});
