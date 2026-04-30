import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TenantConfig } from "../types.js";
import { SafeFs } from "../skills/safe-fs.js";

const execFileAsync = promisify(execFile);

/**
 * A tenant workspace is a self-contained directory containing:
 *   .claude/skills/        — per-skill folders (SKILL.md + supporting files)
 *   services/              — generated TypeScript wrapper libs, one file per vendor
 *   .git/                  — every skill change is a commit
 *
 * Writes by the registry and meta tools go through `safeFs`, which enforces
 * the scope limit from the architecture doc.
 */
export class TenantWorkspace {
  readonly safeFs: SafeFs;

  constructor(public readonly config: TenantConfig) {
    this.safeFs = new SafeFs(this);
  }

  get root(): string {
    return this.config.workspacePath;
  }

  get skillsDir(): string {
    return path.join(this.root, ".claude", "skills");
  }

  get servicesDir(): string {
    return path.join(this.root, "services");
  }

  skillDir(name: string): string {
    return path.join(this.skillsDir, name);
  }

  serviceFile(vendor: string): string {
    return path.join(this.servicesDir, `${vendor}.ts`);
  }

  get stateFile(): string {
    return path.join(this.root, ".specialist-state.json");
  }

  get rollbackLog(): string {
    return path.join(this.root, "rollback.log");
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
    await fs.mkdir(this.servicesDir, { recursive: true });

    const gitDir = path.join(this.root, ".git");
    try {
      await fs.access(gitDir);
    } catch {
      await this.git("init", "-q", "-b", "main");
      await this.git("config", "user.email", "agent@specialist.local");
      await this.git("config", "user.name", "Specialist Agent");
      // Seed an initial commit so branches can be created cleanly.
      const readme = path.join(this.root, "README.md");
      await fs.writeFile(
        readme,
        `# Tenant: ${this.config.id}\n\nPer-tenant skill registry. Managed by the specialist agent.\n`,
      );
      await this.git("add", "README.md");
      await this.git("commit", "-q", "-m", "init tenant workspace");
    }
  }

  async git(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: this.root });
    return { stdout, stderr };
  }

  async listSkillNames(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
