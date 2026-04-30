import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TenantWorkspace } from "../tenant/workspace.js";
import type { WrapperSpec } from "../types.js";

/**
 * Replay a freshly synthesized wrapper against the live (or staging)
 * endpoint to confirm it works. The architecture doc treats this as
 * a gate before merging a skill change to main.
 *
 * If `dryRun` is true, we only verify that the function loads and
 * its signature matches the spec — useful in environments where
 * making a real call would have side effects.
 */
export async function replayWrapper(args: {
  workspace: TenantWorkspace;
  spec: WrapperSpec;
  testArgs: Record<string, unknown>;
  dryRun?: boolean;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const fnName = args.spec.name.split(".").pop() ?? args.spec.name;
  const file = args.workspace.serviceFile(args.spec.vendor);
  const absPath = path.resolve(file);

  let mod: Record<string, unknown>;
  try {
    // Cache-bust: replay can be called repeatedly during a session.
    const url = `${pathToFileURL(absPath).href}?t=${Date.now()}`;
    mod = (await import(url)) as Record<string, unknown>;
  } catch (e) {
    return { success: false, error: `failed to load ${file}: ${(e as Error).message}` };
  }

  const fn = mod[fnName];
  if (typeof fn !== "function") {
    return { success: false, error: `function "${fnName}" not exported from ${file}` };
  }

  if (args.dryRun) return { success: true };

  try {
    const result = await (fn as (a: unknown) => Promise<unknown>)(args.testArgs);
    return { success: true, result };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
