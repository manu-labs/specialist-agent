// Server handler + auth + app — exercises each path with a stubbed
// SpecialistAgent so we never hit the network during unit tests.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { processBundle } from "../src/server/handler.js";
import { ConfigError, parseBundleTokens, TenantResolver } from "../src/server/auth.js";
import { createApp } from "../src/server/app.js";
import { BundleSchema, type Bundle } from "../src/bundle/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "bundle-example.json");

async function loadBundle(): Promise<Bundle> {
  const raw = await fs.readFile(fixturePath, "utf8");
  return BundleSchema.parse(JSON.parse(raw));
}

async function makeVolume(): Promise<{ root: string; tenantPath: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "specialist-test-volume-"));
  const tenantPath = path.join(root, "tenants", "acme");
  return {
    root,
    tenantPath,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("parseBundleTokens — CSV form", () => {
  const out = parseBundleTokens("t1:tenants/a, t2:tenants/b");
  assert.deepStrictEqual(out, { t1: "tenants/a", t2: "tenants/b" });
});

test("parseBundleTokens — JSON form", () => {
  const out = parseBundleTokens('{"t1":"tenants/a","t2":"tenants/b"}');
  assert.deepStrictEqual(out, { t1: "tenants/a", t2: "tenants/b" });
});

test("parseBundleTokens — empty input", () => {
  assert.deepStrictEqual(parseBundleTokens(undefined), {});
  assert.deepStrictEqual(parseBundleTokens(""), {});
});

test("parseBundleTokens — malformed CSV throws", () => {
  assert.throws(() => parseBundleTokens("noseparator"), ConfigError);
});

test("TenantResolver — refuses tenant outside volume", async () => {
  const v = await makeVolume();
  try {
    assert.throws(
      () =>
        new TenantResolver({
          tokens: { t1: "/etc" },
          volumeRoot: v.root,
        }),
      ConfigError,
    );
  } finally {
    await v.cleanup();
  }
});

test("TenantResolver — refuses empty volume root", () => {
  assert.throws(() => new TenantResolver({ tokens: { t1: "/x" }, volumeRoot: "" }), ConfigError);
});

test("TenantResolver — refuses zero tenants", async () => {
  const v = await makeVolume();
  try {
    assert.throws(() => new TenantResolver({ tokens: {}, volumeRoot: v.root }), ConfigError);
  } finally {
    await v.cleanup();
  }
});

test("TenantResolver — accepts tenant under volume + resolves bearer", async () => {
  const v = await makeVolume();
  try {
    const r = new TenantResolver({ tokens: { t1: v.tenantPath }, volumeRoot: v.root });
    const ok = r.resolveBearer("Bearer t1");
    assert.ok(ok);
    assert.equal(ok!.config.workspacePath, v.tenantPath);
    assert.equal(r.resolveBearer(undefined), null);
    assert.equal(r.resolveBearer("Bearer wrong"), null);
    assert.equal(r.resolveBearer("Basic abc"), null);
  } finally {
    await v.cleanup();
  }
});

test("processBundle — happy path calls learnFromTrace and returns synthesis names", async () => {
  const v = await makeVolume();
  try {
    const bundle = await loadBundle();
    let received = null as null | { intent: string; reqs: number };
    const result = await processBundle(
      bundle,
      { id: "acme", workspacePath: v.tenantPath },
      {
        agentFor: () => ({
          async learnFromTrace(trace) {
            received = { intent: trace.intent, reqs: trace.requests.length };
            return { workflow: "onboard_enterprise", wrappers: ["create_customer"], commit: "abc1234" };
          },
        }),
      },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.workflow, "onboard_enterprise");
      assert.deepStrictEqual(result.wrappers, ["create_customer"]);
      assert.equal(result.commit, "abc1234");
      assert.equal(result.tenant, "acme");
      assert.match(result.traceId, /^[0-9a-f-]{36}$/);
    }
    assert.ok(received);
    assert.equal(received!.reqs, 1);
    assert.match(received!.intent, /Onboard a new enterprise customer/);
    assert.match(received!.intent, /\[narration:/);
  } finally {
    await v.cleanup();
  }
});

test("processBundle — wraps synthesis exception as 500", async () => {
  const v = await makeVolume();
  try {
    const bundle = await loadBundle();
    const result = await processBundle(
      bundle,
      { id: "acme", workspacePath: v.tenantPath },
      {
        agentFor: () => ({
          async learnFromTrace() {
            throw new Error("boom");
          },
        }),
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.error, "synthesis_failed");
      assert.match(result.detail, /boom/);
    }
  } finally {
    await v.cleanup();
  }
});

test("createApp — POST /v1/bundles unauthorized without bearer", async () => {
  const v = await makeVolume();
  try {
    const resolver = new TenantResolver({ tokens: { t1: v.tenantPath }, volumeRoot: v.root });
    const app = createApp({
      resolver,
      logRequests: false,
      agentFor: () => ({ async learnFromTrace() { throw new Error("should not run"); } }),
    });
    const res = await app.request("/v1/bundles", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 401);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "unauthorized");
  } finally {
    await v.cleanup();
  }
});

test("createApp — POST /v1/bundles 400 on schema fail", async () => {
  const v = await makeVolume();
  try {
    const resolver = new TenantResolver({ tokens: { t1: v.tenantPath }, volumeRoot: v.root });
    const app = createApp({
      resolver,
      logRequests: false,
      agentFor: () => ({ async learnFromTrace() { throw new Error("should not run"); } }),
    });
    const res = await app.request("/v1/bundles", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "2" }),
      headers: { "Content-Type": "application/json", Authorization: "Bearer t1" },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "invalid_bundle");
  } finally {
    await v.cleanup();
  }
});

test("createApp — POST /v1/bundles 200 happy path", async () => {
  const v = await makeVolume();
  try {
    const bundle = await loadBundle();
    const resolver = new TenantResolver({ tokens: { tok123: v.tenantPath }, volumeRoot: v.root });
    const app = createApp({
      resolver,
      logRequests: false,
      agentFor: () => ({
        async learnFromTrace() {
          return { workflow: "wf_a", wrappers: ["w_x"], commit: "deadbeef" };
        },
      }),
    });
    const res = await app.request("/v1/bundles", {
      method: "POST",
      body: JSON.stringify(bundle),
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok123" },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { accepted: boolean; workflow: string; wrappers: string[]; commit: string; tenant: string; traceId: string };
    assert.equal(body.accepted, true);
    assert.equal(body.workflow, "wf_a");
    assert.deepStrictEqual(body.wrappers, ["w_x"]);
    assert.equal(body.commit, "deadbeef");
    assert.equal(body.tenant, path.basename(v.tenantPath));
  } finally {
    await v.cleanup();
  }
});

test("createApp — GET /healthz reports tenant count + volume", async () => {
  const v = await makeVolume();
  try {
    const resolver = new TenantResolver({ tokens: { t1: v.tenantPath }, volumeRoot: v.root });
    const app = createApp({ resolver, logRequests: false, agentFor: () => ({ async learnFromTrace() { return { workflow: "", wrappers: [], commit: "" }; } }) });
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string; tenants: number; volumeRoot: string };
    assert.equal(body.status, "ok");
    assert.equal(body.tenants, 1);
    assert.equal(body.volumeRoot, v.root);
  } finally {
    await v.cleanup();
  }
});
