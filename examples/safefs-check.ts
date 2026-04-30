// SafeFs scope-rejection smoke test.
//
//   npx tsx examples/safefs-check.ts
//
// Constructs a SafeFs against a temp tenant and confirms that writes
// outside the allowlist throw ScopeViolationError. No network calls.

import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { TenantWorkspace, ScopeViolationError } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function expectViolation(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.error(`FAIL: ${label} — expected ScopeViolationError`);
    process.exit(1);
  } catch (e) {
    if (e instanceof ScopeViolationError) {
      console.log(`OK   ${label} — rejected: ${e.message}`);
    } else {
      console.error(`FAIL: ${label} — got ${(e as Error).name}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
}

async function expectAllowed(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`OK   ${label} — allowed`);
  } catch (e) {
    console.error(`FAIL: ${label} — unexpected ${(e as Error).name}: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function main() {
  const tenantPath = path.resolve(__dirname, "..", "tenants", "_safefs_check");
  await fs.rm(tenantPath, { recursive: true, force: true });
  await fs.mkdir(tenantPath, { recursive: true });

  const ws = new TenantWorkspace({ id: "safefs-check", workspacePath: tenantPath });
  const sfs = ws.safeFs;

  // Outside the workspace entirely.
  await expectViolation("write absolute path outside root", () =>
    sfs.writeFile("/etc/passwd-evil", "x"),
  );

  // Path traversal via .. should resolve to a path outside the workspace.
  await expectViolation("write via .. traversal", () =>
    sfs.writeFile(path.join(tenantPath, "services", "..", "..", "..", "evil"), "x"),
  );

  // Inside workspace but outside allowlist (e.g. a sibling of services/).
  await expectViolation("write to non-allowlisted dir", () =>
    sfs.writeFile(path.join(tenantPath, "secrets", "leak"), "x"),
  );

  // Allowlisted writes succeed.
  await expectAllowed("write skill SKILL.md", () =>
    sfs.writeFile(path.join(tenantPath, ".claude", "skills", "demo", "SKILL.md"), "ok"),
  );
  await expectAllowed("write services file", () =>
    sfs.writeFile(path.join(tenantPath, "services", "demo.ts"), "// ok"),
  );
  await expectAllowed("write state file", () =>
    sfs.writeFile(ws.stateFile, "{}"),
  );
  await expectAllowed("write rollback log", () =>
    sfs.writeFile(ws.rollbackLog, "log entry\n"),
  );

  console.log("\nAll SafeFs assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
