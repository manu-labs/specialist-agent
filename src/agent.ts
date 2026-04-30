import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { TenantWorkspace } from "./tenant/workspace.js";
import { createMetaSkillServer } from "./skills/meta.js";
import { SkillRegistry } from "./skills/registry.js";
import { applyParameterDecisions, synthesizeFromTrace } from "./synthesis/synthesize.js";
import type {
  CommitContext,
  HttpTrace,
  ParameterDecision,
  TenantConfig,
  WrapperParameter,
  WrapperSpec,
} from "./types.js";
import { replayWrapper } from "./execution/replay.js";
import { clearUnproven, failUnproven, isUnproven, parseWrapperCommand } from "./skills/proving.js";

/**
 * Per-tenant agent runtime. Wraps the Claude Agent SDK's `query()` and
 * wires up:
 *   - the tenant's skill directory (loaded via settingSources: ["project"])
 *   - the meta.update_skill MCP server (so the agent can edit its own skills)
 *   - a Bash allowlist scoped to the wrapper CLI
 *
 * The architecture doc calls this "the agent runtime" — one isolated
 * instance per tenant, skills discovered at task time.
 */
export interface SpecialistAgentOptions {
  tenant: TenantConfig;
  /**
   * Confirmation hook for user-instructed skill changes. Defaults to
   * auto-approve in non-interactive contexts; the CLI overrides this.
   */
  confirmInstructedChange?: (summary: string) => Promise<boolean>;
  /**
   * Per-parameter confirmation hook that drives the spec's
   * "Is `"USD"` a wrapper input or a constant?" pass. Called once per
   * parameter on every newly synthesized wrapper. Default: keep all
   * (preserves current behavior for non-interactive callers).
   */
  confirmParameter?: (ctx: {
    wrapper: WrapperSpec;
    parameter: WrapperParameter;
    observedValue: unknown;
  }) => Promise<ParameterDecision>;
  /** Override the model used by the runtime. Defaults to the SDK default. */
  model?: string;
}

export class SpecialistAgent {
  readonly workspace: TenantWorkspace;
  readonly registry: SkillRegistry;

  constructor(private opts: SpecialistAgentOptions) {
    this.workspace = new TenantWorkspace(opts.tenant);
    this.registry = new SkillRegistry(this.workspace);
  }

  async init(): Promise<void> {
    await this.workspace.ensure();
  }

  /**
   * Run a one-shot prompt against the tenant's skills. Yields SDK
   * messages so the host can stream output.
   */
  async *run(prompt: string): AsyncGenerator<SDKMessage, void> {
    await this.init();

    const meta = createMetaSkillServer({
      workspace: this.workspace,
      confirmInstructedChange: this.opts.confirmInstructedChange,
    });

    const wrapperCli = path.resolve(
      // The CLI lives next to this file at compile time; tsx resolves the .ts source.
      new URL(".", import.meta.url).pathname,
      "cli",
      "wrapper.ts",
    );

    for await (const msg of query({
      prompt,
      options: {
        cwd: this.workspace.root,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        settingSources: ["project"],
        // Skills load from .claude/skills/<name>/SKILL.md inside cwd.
        // Bash + the meta MCP server give the agent everything it needs.
        allowedTools: [
          "Skill",
          "Read",
          "Glob",
          "Grep",
          "Bash",
          "mcp__specialist-meta__reactive_fix",
          "mcp__specialist-meta__update_wrapper",
          "mcp__specialist-meta__add_workflow",
        ],
        mcpServers: {
          "specialist-meta": meta,
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.systemPromptAppendix(wrapperCli),
        },
        hooks: this.buildHooks(),
        // Don't let runaway loops burn the budget on a single user turn.
        maxTurns: 25,
      },
    })) {
      yield msg;
    }
  }

  /**
   * Hooks that drive the auto-rollback guardrail. Spec: "If a freshly-merged
   * skill version fails on its first production invocation, the agent reverts
   * the commit and falls back to the prior version."
   *
   * PostToolUse fires after every Bash invocation (success or non-zero exit).
   * PostToolUseFailure fires when the tool itself errored (timeout, etc).
   * For each, we parse the command back to <vendor>.<function>, then either
   * clear the unproven mark on success or revert on failure.
   */
  private buildHooks() {
    const workspace = this.workspace;
    const registry = this.registry;

    const onBashFinish = async (
      command: string,
      outcome: { success: boolean; reason: string },
    ) => {
      const parsed = parseWrapperCommand(command);
      if (!parsed) return;

      const entry = await isUnproven(workspace, parsed.wrapperName);
      if (!entry) return;

      if (outcome.success) {
        await clearUnproven(workspace, parsed.wrapperName);
      } else {
        await failUnproven(workspace, parsed.wrapperName, registry, outcome.reason);
      }
    };

    return {
      PostToolUse: [
        {
          hooks: [
            async (input: unknown) => {
              const i = input as {
                tool_name?: string;
                tool_input?: { command?: string };
                tool_response?: unknown;
              };
              if (i.tool_name !== "Bash" || !i.tool_input?.command) {
                return { continue: true };
              }
              const success = !looksLikeBashFailure(i.tool_response);
              await onBashFinish(i.tool_input.command, {
                success,
                reason: success ? "ok" : describeBashFailure(i.tool_response),
              });
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (input: unknown) => {
              const i = input as {
                tool_name?: string;
                tool_input?: { command?: string };
                error?: string;
              };
              if (i.tool_name !== "Bash" || !i.tool_input?.command) {
                return { continue: true };
              }
              await onBashFinish(i.tool_input.command, {
                success: false,
                reason: i.error ?? "tool error",
              });
              return { continue: true };
            },
          ],
        },
      ],
    };
  }

  /**
   * Synthesize a new workflow from a captured HTTP trace, validate
   * each generated wrapper, and commit. Returns the names that were
   * added (or updated).
   */
  async learnFromTrace(trace: HttpTrace, opts: { skipReplay?: boolean } = {}): Promise<{
    workflow: string;
    wrappers: string[];
    commit: string;
  }> {
    await this.init();

    const existing = await this.listExistingWrappers();
    const result = await synthesizeFromTrace({
      trace,
      existingWrappers: existing,
    });

    // Spec: parameter confirmation pass — "Is `"USD"` a wrapper input or a
    // constant?". Walk every parameter on every new wrapper, ask the host,
    // and inline frozen values. Default hook keeps all parameters.
    const confirmParam = this.opts.confirmParameter ?? (async () => ({ action: "keep" }) as ParameterDecision);
    for (const w of result.wrappers) {
      const decisions: Record<string, ParameterDecision> = {};
      for (const param of w.spec.parameters) {
        decisions[param.name] = await confirmParam({
          wrapper: w.spec,
          parameter: param,
          observedValue: w.observedValues[param.name],
        });
      }
      const applied = applyParameterDecisions({
        spec: w.spec,
        implementation: w.implementation,
        decisions,
      });
      w.spec = applied.spec;
      w.implementation = applied.implementation;
    }

    const branch = `synth/${result.workflow.name}-${Date.now()}`;
    await this.registry.checkoutBranch(branch);
    const written = await this.registry.writeSynthesisResult(result);

    // Replay each new wrapper. If replay can't be live (no API keys, no
    // staging), the caller can pass skipReplay and validation defers.
    const failures: string[] = [];
    if (!opts.skipReplay) {
      for (const w of result.wrappers) {
        const replayArgs = pickReplayArgs(w.spec);
        const r = await replayWrapper({
          workspace: this.workspace,
          spec: w.spec,
          testArgs: replayArgs,
          // Default to dry-run unless explicit replay args fully populate
          // every required parameter. Live replay belongs in a staging
          // pipeline the host owns.
          dryRun: true,
        });
        if (!r.success) failures.push(`${w.spec.name}: ${r.error}`);
      }
    }

    const ctx: CommitContext = {
      trigger: "synthesis",
      actor: "agent",
      message: `synth: ${result.workflow.name} (${result.wrappers.length} wrapper${result.wrappers.length === 1 ? "" : "s"}) — ${trace.intent}`,
      validation: opts.skipReplay
        ? undefined
        : { replayed: true, success: failures.length === 0, notes: failures.join("; ") || undefined },
    };
    const commit = await this.registry.commit(ctx);

    if (failures.length === 0) {
      await this.registry.mergeToMain(branch);
    }

    return { workflow: written.workflow, wrappers: written.wrappers, commit };
  }

  private async listExistingWrappers(): Promise<Array<{ name: string; description: string }>> {
    const names = await this.workspace.listSkillNames();
    const out: Array<{ name: string; description: string }> = [];
    for (const name of names) {
      const skill = await this.registry.readSkill(name);
      if (!skill) continue;
      if ((skill.metadata.kind ?? "wrapper") !== "wrapper") continue;
      out.push({
        name,
        description: skill.metadata.description ?? "",
      });
    }
    return out;
  }

  private systemPromptAppendix(wrapperCli: string): string {
    return [
      "You are a specialist agent that has learned this customer's workflows from observed HTTP traces.",
      "Your skills come from two layers:",
      "  - Layer 1 wrappers (kind: wrapper): one per HTTP endpoint. Invoke via shell with the specialist-wrapper CLI.",
      "  - Layer 2 workflows (kind: workflow): pure prose describing how to compose wrappers.",
      "",
      "When you receive a task:",
      "  1. Use the Skill tool to discover relevant skills. Prefer a workflow if one matches; otherwise use wrappers directly.",
      "  2. For each step, identify the right wrapper, extract arguments from the prompt or prior step responses, and shell out:",
      `       npx tsx ${wrapperCli} <vendor> <function> --arg=value --tenant=<workspace-root>`,
      "     The wrapper outputs JSON on stdout. Parse it before extracting values for the next step.",
      "  3. If a wrapper call fails or returns an unexpected shape, load the wrapper's SKILL.md, the failed request/response, and prior successful steps, then re-reason.",
      "     If the failure looks like persistent API drift (not transient), invoke `meta.update_skill.reactive_fix` to fix the wrapper for future runs. Validate via replay before merge.",
      "  4. If the user instructs you to change a skill mid-task ('also pass X', 'use the v2 endpoint now'), use `meta.update_skill.update_wrapper` and confirm the summary with the user before applying.",
      "  5. If the user walks you through a new sequence in conversation, use `meta.update_skill.add_workflow` to capture it permanently.",
      "",
      "Rules:",
      "  - Never edit files under services/ or .claude/skills/ directly with Edit/Write — always go through the meta tools so changes are validated and committed.",
      "  - Never read files outside the tenant workspace.",
      "  - Be terse. The user sees your text output but not your tool calls.",
    ].join("\n");
  }
}

/**
 * Heuristic: did the Bash tool's response indicate the command failed?
 *
 * The Claude Code Bash tool returns its result as text + flags. A non-zero
 * exit doesn't make the *tool* fail (the command ran), but the output usually
 * carries a signal we can pick up: `is_error`, an explicit `error` field, or
 * the wrapper CLI's own "wrapper failed:" prefix on stderr.
 */
function looksLikeBashFailure(response: unknown): boolean {
  if (response == null) return false;
  if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (r.is_error === true) return true;
    if (typeof r.error === "string" && r.error.length > 0) return true;
    const text = [r.output, r.stdout, r.stderr, r.content]
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    if (text.includes("wrapper failed:")) return true;
  }
  if (typeof response === "string" && response.includes("wrapper failed:")) return true;
  return false;
}

function describeBashFailure(response: unknown): string {
  if (response == null) return "(no response)";
  if (typeof response === "string") return response.slice(0, 500);
  const r = response as Record<string, unknown>;
  if (typeof r.error === "string") return r.error.slice(0, 500);
  const text = [r.stderr, r.output, r.stdout, r.content]
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  return text.slice(0, 500) || "(unknown failure)";
}

function pickReplayArgs(spec: { parameters: Array<{ name: string; type: string; required: boolean }> }): Record<string, unknown> {
  // Best-effort placeholder values for dry-run validation. Live replay is
  // the host's responsibility — production deployments wire this to a
  // staging fixture.
  const out: Record<string, unknown> = {};
  for (const p of spec.parameters) {
    if (!p.required) continue;
    switch (p.type) {
      case "string":
        out[p.name] = "test_value";
        break;
      case "number":
        out[p.name] = 1;
        break;
      case "boolean":
        out[p.name] = false;
        break;
      default:
        out[p.name] = {};
    }
  }
  return out;
}
