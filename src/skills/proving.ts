import { promises as fs } from "node:fs";
import type { TenantWorkspace } from "../tenant/workspace.js";
import type { SkillRegistry } from "./registry.js";

/**
 * "Unproven" tracker for the auto-rollback guardrail.
 *
 * Spec: "If a freshly-merged skill version fails on its first production
 * invocation, the agent reverts the commit and falls back to the prior
 * version."
 *
 * Scope: only meta-tool merges (reactive_fix, update_wrapper) flag the
 * wrapper as unproven. Synthesis goes through replay validation and is
 * left out of this loop.
 *
 * State lives at tenants/<id>/.specialist-state.json. Writes go through
 * SafeFs so they can never escape the workspace.
 */

interface UnprovenEntry {
  commit: string;
  mergedAt: string;
}

interface State {
  unproven: Record<string, UnprovenEntry>;
}

async function readState(workspace: TenantWorkspace): Promise<State> {
  try {
    const raw = await fs.readFile(workspace.stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return { unproven: parsed.unproven ?? {} };
  } catch {
    return { unproven: {} };
  }
}

async function writeState(workspace: TenantWorkspace, state: State): Promise<void> {
  await workspace.safeFs.writeFile(workspace.stateFile, JSON.stringify(state, null, 2) + "\n");
}

export async function markUnproven(
  workspace: TenantWorkspace,
  wrapperName: string,
  commit: string,
): Promise<void> {
  const state = await readState(workspace);
  state.unproven[wrapperName] = { commit, mergedAt: new Date().toISOString() };
  await writeState(workspace, state);
}

export async function isUnproven(
  workspace: TenantWorkspace,
  wrapperName: string,
): Promise<UnprovenEntry | null> {
  const state = await readState(workspace);
  return state.unproven[wrapperName] ?? null;
}

export async function clearUnproven(
  workspace: TenantWorkspace,
  wrapperName: string,
): Promise<void> {
  const state = await readState(workspace);
  if (!(wrapperName in state.unproven)) return;
  delete state.unproven[wrapperName];
  await writeState(workspace, state);
}

/**
 * The wrapper failed on its first post-merge invocation. Revert the
 * commit, clear the mark, and append a line to rollback.log so the
 * host can review.
 */
export async function failUnproven(
  workspace: TenantWorkspace,
  wrapperName: string,
  registry: SkillRegistry,
  reason: string,
): Promise<void> {
  const entry = await isUnproven(workspace, wrapperName);
  if (!entry) return;

  // Revert before clearing the mark so a crash mid-flight doesn't
  // leave a permanent mark behind. The revert itself is idempotent —
  // git revert <hash> against an already-reverted hash is a no-op.
  await registry.revertLastCommit();
  await clearUnproven(workspace, wrapperName);

  const line = JSON.stringify({
    at: new Date().toISOString(),
    wrapper: wrapperName,
    revertedCommit: entry.commit,
    reason,
  });
  await appendRollbackLog(workspace, line);
}

async function appendRollbackLog(workspace: TenantWorkspace, line: string): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(workspace.rollbackLog, "utf8");
  } catch {
    // File doesn't exist yet — fine.
  }
  await workspace.safeFs.writeFile(workspace.rollbackLog, existing + line + "\n");
}

/**
 * Parse a wrapper-CLI bash command back into <vendor>.<function>.
 * Returns null if the command isn't a wrapper invocation.
 */
export function parseWrapperCommand(command: string): { wrapperName: string } | null {
  // The agent invokes via:
  //   npx tsx <abs-path>/wrapper.ts <vendor> <function> --... --tenant=...
  //   specialist-wrapper <vendor> <function> ...
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens) return null;

  // Find the index of either wrapper.ts or specialist-wrapper.
  let cliIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (t.endsWith("/wrapper.ts") || t === "wrapper.ts" || t === "specialist-wrapper") {
      cliIdx = i;
      break;
    }
  }
  if (cliIdx === -1) return null;

  const vendor = tokens[cliIdx + 1];
  const fn = tokens[cliIdx + 2];
  if (!vendor || !fn || vendor.startsWith("--") || fn.startsWith("--")) return null;
  return { wrapperName: `${vendor}.${fn}` };
}
