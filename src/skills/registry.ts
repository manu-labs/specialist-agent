import { promises as fs } from "node:fs";
import path from "node:path";
import type { TenantWorkspace } from "../tenant/workspace.js";
import type { CommitContext, SkillMetadata, SynthesisResult, WrapperSpec } from "../types.js";

// All filesystem writes here go through workspace.safeFs — see safe-fs.ts.
// `fs` is only retained for reads, which are unrestricted.

/**
 * Git-backed skill registry. Every mutation is a commit. Branches are
 * used for in-flight changes that haven't passed validation; merge to
 * main only after replay succeeds.
 */
export class SkillRegistry {
  constructor(private workspace: TenantWorkspace) {}

  async writeSynthesisResult(result: SynthesisResult): Promise<{ workflow: string; wrappers: string[] }> {
    await this.workspace.ensure();

    // Layer 1: wrapper skills + service code
    const wrapperNames: string[] = [];
    for (const w of result.wrappers) {
      await this.writeWrapper(w.spec, w.implementation);
      wrapperNames.push(w.spec.name);
    }

    // Layer 2: workflow skill (pure markdown)
    await this.writeWorkflow(result.workflow);

    return { workflow: result.workflow.name, wrappers: wrapperNames };
  }

  async writeWrapper(spec: WrapperSpec, implementation: string): Promise<void> {
    const dir = this.workspace.skillDir(spec.name);
    await this.workspace.safeFs.mkdir(dir, { recursive: true });

    const skillMd = renderWrapperSkillMd(spec);
    await this.workspace.safeFs.writeFile(path.join(dir, "SKILL.md"), skillMd);

    await this.upsertServiceFunction(spec, implementation);
  }

  async writeWorkflow(workflow: SynthesisResult["workflow"]): Promise<void> {
    const dir = this.workspace.skillDir(workflow.name);
    await this.workspace.safeFs.mkdir(dir, { recursive: true });
    const md = renderWorkflowSkillMd(workflow);
    await this.workspace.safeFs.writeFile(path.join(dir, "SKILL.md"), md);
  }

  /**
   * Append (or replace) a function in the per-vendor service file.
   * The file is regenerated from a marker-delimited block per function
   * so synthesis can call this idempotently.
   */
  async upsertServiceFunction(spec: WrapperSpec, implementation: string): Promise<void> {
    const file = this.workspace.serviceFile(spec.vendor);
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      existing = renderServiceFileHeader(spec.vendor);
    }

    const block = renderFunctionBlock(spec, implementation);
    const startMarker = `// >>> ${spec.name}`;
    const endMarker = `// <<< ${spec.name}`;

    let next: string;
    const startIdx = existing.indexOf(startMarker);
    if (startIdx === -1) {
      next = existing.trimEnd() + "\n\n" + block + "\n";
    } else {
      const endIdx = existing.indexOf(endMarker, startIdx);
      if (endIdx === -1) {
        next = existing.trimEnd() + "\n\n" + block + "\n";
      } else {
        const before = existing.slice(0, startIdx);
        const after = existing.slice(endIdx + endMarker.length);
        next = before + block + after;
      }
    }

    await this.workspace.safeFs.writeFile(file, next);
  }

  async commit(ctx: CommitContext): Promise<string> {
    await this.workspace.git("add", "-A");
    // Skip if nothing staged — git commit -q would otherwise fail.
    const { stdout } = await this.workspace.git("status", "--porcelain");
    if (!stdout.trim()) return "";
    const meta = JSON.stringify({
      trigger: ctx.trigger,
      actor: ctx.actor,
      validation: ctx.validation,
    });
    const message = `${ctx.message}\n\n${meta}`;
    await this.workspace.git("commit", "-q", "-m", message);
    const { stdout: hash } = await this.workspace.git("rev-parse", "HEAD");
    return hash.trim();
  }

  async revertLastCommit(): Promise<void> {
    await this.workspace.git("revert", "--no-edit", "HEAD");
  }

  async checkoutBranch(name: string): Promise<void> {
    await this.workspace.git("checkout", "-B", name);
  }

  async mergeToMain(branch: string): Promise<void> {
    await this.workspace.git("checkout", "main");
    await this.workspace.git("merge", "--ff-only", branch);
  }

  async readSkill(name: string): Promise<{ metadata: Partial<SkillMetadata>; body: string } | null> {
    try {
      const md = await fs.readFile(path.join(this.workspace.skillDir(name), "SKILL.md"), "utf8");
      return parseSkillMd(md);
    } catch {
      return null;
    }
  }
}

function renderWrapperSkillMd(spec: WrapperSpec): string {
  const params = spec.parameters
    .map((p) => `- \`${p.name}\` (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`)
    .join("\n");

  const usageArgs = spec.parameters
    .filter((p) => p.required)
    .map((p) => `--${p.name}=<${p.name}>`)
    .join(" ");

  return `---
name: ${spec.name}
description: ${spec.description} Use when: ${spec.whenToUse}
kind: wrapper
vendor: ${spec.vendor}
---

# ${spec.name}

${spec.description}

## When to use

${spec.whenToUse}

## HTTP call

\`${spec.http.method} ${spec.http.urlTemplate}\` — ${spec.http.contentType}

## Inputs

${params || "_(none)_"}

## Returns

${spec.returns}

## Invocation

Run from a shell:

\`\`\`bash
specialist-wrapper ${spec.vendor} ${spec.name.split(".").pop() ?? spec.name} ${usageArgs}
\`\`\`

The wrapper returns parsed JSON on stdout. On error it exits non-zero with diagnostics on stderr.
`;
}

function renderWorkflowSkillMd(workflow: SynthesisResult["workflow"]): string {
  const inputs = workflow.inputs
    .map((p) => `- \`${p.name}\` (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`)
    .join("\n");

  const steps = workflow.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return `---
name: ${workflow.name}
description: ${workflow.description} Use when: ${workflow.whenToUse}
kind: workflow
---

# ${workflow.name}

${workflow.description}

## When to use

${workflow.whenToUse}

## Inputs

${inputs || "_(none)_"}

## Steps

${steps}

## Notes

- Wrappers referenced by name resolve to skills under \`.claude/skills/\`.
- For each step, identify the right wrapper from the prompt + prior step responses, extract arguments, and invoke via shell.
- If a wrapper call fails, load the wrapper's SKILL.md, the failed request/response, and prior successful steps, then re-reason the next move. If the failure looks like persistent drift, invoke \`meta.update_skill\` to fix the wrapper.
`;
}

function renderServiceFileHeader(vendor: string): string {
  return `// ${vendor} service lib — generated by specialist-agent.
//
// Each exported function is a thin HTTP wrapper. No retry logic, no response
// shaping, no convenience parameters. Smarter behavior belongs in a workflow
// skill or in the agent's reasoning layer.
//
// Auth is supplied by the AuthBroker at call time.

import { runWrapper } from "../../../src/execution/runner.js";

`;
}

function renderFunctionBlock(spec: WrapperSpec, implementation: string): string {
  const params = spec.parameters
    .map((p) => `${p.name}${p.required ? "" : "?"}: ${tsType(p.type)}`)
    .join("; ");
  const fnName = spec.name.split(".").pop() ?? spec.name;
  return `// >>> ${spec.name}
export async function ${fnName}(args: { ${params} }): Promise<unknown> {
${indent(implementation.trim(), 2)}
}
// <<< ${spec.name}`;
}

function tsType(t: string): string {
  switch (t) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "Record<string, unknown>";
  }
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function parseSkillMd(md: string): { metadata: Partial<SkillMetadata>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) return { metadata: {}, body: md };
  const front = m[1] ?? "";
  const body = m[2] ?? "";
  const metadata: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    metadata[k] = v;
  }
  return { metadata: metadata as Partial<SkillMetadata>, body };
}
