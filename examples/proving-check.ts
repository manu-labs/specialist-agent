// Smoke test for the auto-rollback tracker.
//
//   npx tsx examples/proving-check.ts
//
// Verifies markUnproven/clearUnproven persist correctly, failUnproven
// reverts and writes to rollback.log, and parseWrapperCommand picks
// out the wrapper name from the agent's bash invocation strings.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TenantWorkspace, SkillRegistry } from "../src/index.js";
import {
  clearUnproven,
  failUnproven,
  isUnproven,
  markUnproven,
  parseWrapperCommand,
} from "../src/skills/proving.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: expected ${e}, got ${a}`);
    process.exit(1);
  }
  console.log(`OK   ${label}`);
}

async function main() {
  const tenantPath = path.resolve(__dirname, "..", "tenants", "_proving_check");
  await fs.rm(tenantPath, { recursive: true, force: true });
  await fs.mkdir(tenantPath, { recursive: true });

  const ws = new TenantWorkspace({ id: "proving-check", workspacePath: tenantPath });
  await ws.ensure();
  const registry = new SkillRegistry(ws);

  // parseWrapperCommand variants
  assertEqual(
    "parses npx tsx wrapper.ts form",
    parseWrapperCommand(
      "npx tsx /tmp/wrapper.ts stripe create_invoice --customer=cus_1 --tenant=/tmp",
    ),
    { wrapperName: "stripe.create_invoice" },
  );
  assertEqual(
    "parses specialist-wrapper form",
    parseWrapperCommand("specialist-wrapper github create_issue --title=foo"),
    { wrapperName: "github.create_issue" },
  );
  assertEqual(
    "rejects unrelated bash",
    parseWrapperCommand("ls -la /tmp"),
    null,
  );

  // Mark / read / clear cycle
  await markUnproven(ws, "stripe.create_invoice", "deadbeef");
  const entry = await isUnproven(ws, "stripe.create_invoice");
  if (!entry || entry.commit !== "deadbeef") {
    console.error("FAIL markUnproven did not persist");
    process.exit(1);
  }
  console.log("OK   markUnproven persisted");

  await clearUnproven(ws, "stripe.create_invoice");
  const cleared = await isUnproven(ws, "stripe.create_invoice");
  assertEqual("clearUnproven removes entry", cleared, null);

  // failUnproven: mark, then commit a real change so revert has something
  // to undo, then trigger fail and confirm the working tree is back to pre-mark
  // state with a rollback.log entry.
  await ws.safeFs.writeFile(
    path.join(ws.servicesDir, "demo.ts"),
    "// before\n",
  );
  await registry.commit({
    trigger: "synthesis",
    actor: "agent",
    message: "before",
  });
  await ws.safeFs.writeFile(
    path.join(ws.servicesDir, "demo.ts"),
    "// after\n",
  );
  const updateCommit = await registry.commit({
    trigger: "user-instruction",
    actor: "agent",
    message: "after",
  });
  await markUnproven(ws, "demo.update", updateCommit);

  await failUnproven(ws, "demo.update", registry, "simulated 500");

  const onDisk = await fs.readFile(path.join(ws.servicesDir, "demo.ts"), "utf8");
  assertEqual("failUnproven reverted file content", onDisk, "// before\n");
  const log = await fs.readFile(ws.rollbackLog, "utf8");
  if (!log.includes("demo.update") || !log.includes("simulated 500")) {
    console.error(`FAIL rollback.log missing entry. Got: ${log}`);
    process.exit(1);
  }
  console.log("OK   rollback.log appended");
  const after = await isUnproven(ws, "demo.update");
  assertEqual("failUnproven cleared mark", after, null);

  console.log("\nAll proving assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
