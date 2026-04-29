import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TenantWorkspace } from "../tenant/workspace.js";
import { SkillRegistry } from "./registry.js";
import { replayWrapper } from "../execution/replay.js";
import type { CommitContext, WrapperSpec } from "../types.js";

/**
 * The meta.update_skill MCP server gives the agent three tools to modify
 * its own skill set, with the guardrails described in the architecture doc:
 *   - reactive_fix: applies automatically (clear failure → drift → fix)
 *   - update_wrapper: requires user confirmation; the agent shows a summary
 *   - add_workflow: assembles a new workflow from conversation
 *
 * Scope limit: these tools can ONLY edit files inside the tenant workspace.
 * The auth broker, runtime, and the meta server itself are off-limits.
 */
export function createMetaSkillServer(args: {
  workspace: TenantWorkspace;
  /**
   * Hook the host can use to require explicit user confirmation for
   * user-instructed changes. Return false to abort.
   */
  confirmInstructedChange?: (summary: string) => Promise<boolean>;
}) {
  const registry = new SkillRegistry(args.workspace);
  const confirm = args.confirmInstructedChange ?? (async () => true);

  const reactiveFix = tool(
    "reactive_fix",
    "Apply a reactive fix to a wrapper skill that just failed with persistent drift. " +
      "Use this when an API has clearly changed shape (status code, schema, URL) and the failure is not transient. " +
      "Validates against staging via replay before merging.",
    {
      wrapperName: z.string().describe('Wrapper skill name, e.g. "stripe.create_invoice"'),
      diffSummary: z
        .string()
        .describe("One-line summary of what drifted, in past tense (e.g. 'response shape moved invoice_id under .data.id')"),
      updatedSpec: z
        .object({
          name: z.string(),
          vendor: z.string(),
          description: z.string(),
          whenToUse: z.string(),
          http: z.object({
            method: z.string(),
            urlTemplate: z.string(),
            contentType: z.string(),
          }),
          parameters: z.array(
            z.object({
              name: z.string(),
              type: z.enum(["string", "number", "boolean", "object"]),
              description: z.string(),
              required: z.boolean(),
            }),
          ),
          returns: z.string(),
        })
        .describe("Full updated wrapper spec — replaces the existing one."),
      updatedImplementation: z
        .string()
        .describe("New TypeScript function body (no signature) that calls runWrapper(...)"),
      replayArgs: z
        .record(z.unknown())
        .describe("Concrete arguments to use when replaying the wrapper for validation."),
    },
    async (input) => {
      const branch = `meta/reactive-fix-${input.wrapperName}-${Date.now()}`;
      await registry.checkoutBranch(branch);
      await registry.writeWrapper(input.updatedSpec as WrapperSpec, input.updatedImplementation);

      const replay = await replayWrapper({
        workspace: args.workspace,
        spec: input.updatedSpec as WrapperSpec,
        testArgs: input.replayArgs,
      });

      const ctx: CommitContext = {
        trigger: "reactive-fix",
        actor: "agent",
        message: `meta: reactive fix for ${input.wrapperName} — ${input.diffSummary}`,
        validation: { replayed: true, success: replay.success, notes: replay.error },
      };
      await registry.commit(ctx);

      if (!replay.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Reactive fix DID NOT validate. Branch \`${branch}\` retained for review. Error: ${replay.error}`,
            },
          ],
          isError: true,
        };
      }

      await registry.mergeToMain(branch);
      return {
        content: [
          {
            type: "text" as const,
            text: `Reactive fix applied: ${input.wrapperName} updated, replayed, and merged to main.`,
          },
        ],
      };
    },
  );

  const updateWrapper = tool(
    "update_wrapper",
    "Update a wrapper skill in response to an explicit user instruction (e.g. 'also pass tax_rate', 'this should hit v2 now'). " +
      "Requires the user to confirm a one-line summary before applying.",
    {
      wrapperName: z.string(),
      summary: z.string().describe("One-line user-facing summary, e.g. 'add tax_rate parameter to stripe.create_invoice'"),
      updatedSpec: z
        .object({
          name: z.string(),
          vendor: z.string(),
          description: z.string(),
          whenToUse: z.string(),
          http: z.object({
            method: z.string(),
            urlTemplate: z.string(),
            contentType: z.string(),
          }),
          parameters: z.array(
            z.object({
              name: z.string(),
              type: z.enum(["string", "number", "boolean", "object"]),
              description: z.string(),
              required: z.boolean(),
            }),
          ),
          returns: z.string(),
        }),
      updatedImplementation: z.string(),
      replayArgs: z.record(z.unknown()).describe("Args for staging replay."),
    },
    async (input) => {
      const ok = await confirm(input.summary);
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: "User declined the change; no edit made." }],
        };
      }

      const branch = `meta/update-${input.wrapperName}-${Date.now()}`;
      await registry.checkoutBranch(branch);
      await registry.writeWrapper(input.updatedSpec as WrapperSpec, input.updatedImplementation);

      const replay = await replayWrapper({
        workspace: args.workspace,
        spec: input.updatedSpec as WrapperSpec,
        testArgs: input.replayArgs,
      });

      await registry.commit({
        trigger: "user-instruction",
        actor: "agent",
        message: `meta: ${input.summary}`,
        validation: { replayed: true, success: replay.success, notes: replay.error },
      });

      if (!replay.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Change validated and committed to branch \`${branch}\` but replay FAILED — staying on branch. Error: ${replay.error}`,
            },
          ],
          isError: true,
        };
      }

      await registry.mergeToMain(branch);
      return {
        content: [
          { type: "text" as const, text: `Wrapper ${input.wrapperName} updated, replayed, and merged.` },
        ],
      };
    },
  );

  const addWorkflow = tool(
    "add_workflow",
    "Add a new workflow skill assembled from conversation (the user walked the agent through a sequence in chat without turning on capture). " +
      "Pure markdown — no replay needed. Still requires user confirmation.",
    {
      summary: z.string().describe("One-line description of the workflow being added."),
      workflow: z.object({
        name: z.string(),
        description: z.string(),
        whenToUse: z.string(),
        steps: z.array(z.string()),
        inputs: z.array(
          z.object({
            name: z.string(),
            type: z.enum(["string", "number", "boolean", "object"]),
            description: z.string(),
            required: z.boolean(),
          }),
        ),
      }),
    },
    async (input) => {
      const ok = await confirm(input.summary);
      if (!ok) {
        return { content: [{ type: "text" as const, text: "User declined; no workflow added." }] };
      }

      await registry.writeWorkflow(input.workflow);
      await registry.commit({
        trigger: "additive-learning",
        actor: "agent",
        message: `meta: add workflow — ${input.summary}`,
      });

      return {
        content: [
          { type: "text" as const, text: `Workflow ${input.workflow.name} added and committed.` },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "specialist-meta",
    version: "0.1.0",
    tools: [reactiveFix, updateWrapper, addWorkflow],
  });
}
