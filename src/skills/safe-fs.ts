import { promises as fs } from "node:fs";
import path from "node:path";
import type { TenantWorkspace } from "../tenant/workspace.js";

/**
 * Filesystem gate for everything the meta tools and registry write.
 *
 * The architecture doc says scope limits should be "enforced via filesystem
 * permissions, not just convention." A real OS-permission sandbox needs a
 * subprocess with bind mounts; that's out of scope for v1. SafeFs instead
 * funnels every write through one validator that resolves the target path
 * and asserts it lives inside one of these allowlisted prefixes:
 *
 *   .claude/skills/         — wrapper + workflow skill files
 *   services/               — generated wrapper functions
 *   .specialist-state.json  — proving tracker
 *   rollback.log            — rollback audit trail
 *
 * Anything else throws ScopeViolationError. As long as the meta tools and
 * registry never bypass SafeFs, the agent cannot edit the auth broker, the
 * runtime, or itself — even under prompt injection.
 */
export class SafeFs {
  constructor(private workspace: TenantWorkspace) {}

  async writeFile(absPath: string, content: string): Promise<void> {
    this.assertWithin(absPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf8");
  }

  async mkdir(absPath: string, opts: { recursive?: boolean } = {}): Promise<void> {
    this.assertWithin(absPath);
    await fs.mkdir(absPath, { recursive: opts.recursive ?? false });
  }

  async unlink(absPath: string): Promise<void> {
    this.assertWithin(absPath);
    await fs.unlink(absPath);
  }

  async readFile(absPath: string): Promise<string> {
    // Reads don't need the same gate (the agent could read anything via
    // the SDK's Read tool anyway), but routing them through SafeFs keeps
    // call sites uniform.
    return fs.readFile(absPath, "utf8");
  }

  /**
   * Resolve absPath, normalize traversal, and reject anything outside the
   * allowlist. Symlink escape is mitigated by `path.resolve` collapsing
   * `..` segments before the prefix check; symlinks pointing outside
   * still pass the string check (a real attacker would need write access
   * to plant the symlink, which they wouldn't have without already being
   * past SafeFs). For v1 this is the right tradeoff.
   */
  private assertWithin(absPath: string): void {
    const resolved = path.resolve(absPath);
    const root = path.resolve(this.workspace.root);
    const rel = path.relative(root, resolved);

    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ScopeViolationError(
        `path "${absPath}" is outside tenant workspace ${root}`,
      );
    }

    const allowlist = [
      ".claude/skills",
      "services",
      ".specialist-state.json",
      "rollback.log",
    ];

    const ok = allowlist.some((prefix) => {
      if (rel === prefix) return true;
      return rel.startsWith(prefix + path.sep);
    });

    if (!ok) {
      throw new ScopeViolationError(
        `path "${rel}" is not in the SafeFs allowlist (allowed: ${allowlist.join(", ")})`,
      );
    }
  }
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}
