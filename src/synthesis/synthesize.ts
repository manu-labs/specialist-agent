import Anthropic from "@anthropic-ai/sdk";
import type { HttpTrace, SynthesisResult } from "../types.js";
import { SYNTHESIS_SYSTEM_PROMPT, renderUserPrompt } from "./prompt.js";

const SYNTHESIS_MODEL = "claude-opus-4-7";

const SYNTHESIS_TOOL = {
  name: "emit_skills",
  description: "Emit the synthesized wrapper skills and workflow skill.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflow: {
        type: "object",
        properties: {
          name: { type: "string", description: "snake_case identifier" },
          description: { type: "string" },
          whenToUse: { type: "string" },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered prose steps referencing wrapper names.",
          },
          inputs: { type: "array", items: parameterSchema() },
        },
        required: ["name", "description", "whenToUse", "steps", "inputs"],
      },
      wrappers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            spec: {
              type: "object",
              properties: {
                name: { type: "string", description: "dotted form: <vendor>.<verb_object>" },
                vendor: { type: "string" },
                description: { type: "string" },
                whenToUse: { type: "string" },
                http: {
                  type: "object",
                  properties: {
                    method: { type: "string" },
                    urlTemplate: { type: "string", description: "URL with {arg} placeholders" },
                    contentType: { type: "string" },
                  },
                  required: ["method", "urlTemplate", "contentType"],
                },
                parameters: { type: "array", items: parameterSchema() },
                returns: { type: "string", description: "Plain-English description of the response shape." },
              },
              required: ["name", "vendor", "description", "whenToUse", "http", "parameters", "returns"],
            },
            implementation: {
              type: "string",
              description:
                "TypeScript function body (without signature) that returns runWrapper({...}). Has access to `args` and `runWrapper`.",
            },
          },
          required: ["spec", "implementation"],
        },
      },
    },
    required: ["workflow", "wrappers"],
  },
};

function parameterSchema() {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      type: { type: "string", enum: ["string", "number", "boolean", "object"] },
      description: { type: "string" },
      required: { type: "boolean" },
    },
    required: ["name", "type", "description", "required"],
  };
}

/**
 * Single Claude call: trimmed HTTP trace + user intent → wrapper + workflow skills.
 *
 * Uses prompt caching on the system prompt because in production this synth
 * call gets made many times per day per tenant.
 */
export async function synthesizeFromTrace(args: {
  trace: HttpTrace;
  existingWrappers: Array<{ name: string; description: string }>;
  client?: Anthropic;
}): Promise<SynthesisResult> {
  const client = args.client ?? new Anthropic();
  const userPrompt = renderUserPrompt({
    trace: args.trace,
    existingWrappers: args.existingWrappers,
  });

  const response = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 16000,
    system: [
      {
        type: "text",
        text: SYNTHESIS_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [SYNTHESIS_TOOL],
    tool_choice: { type: "tool", name: SYNTHESIS_TOOL.name },
    messages: [{ role: "user", content: userPrompt }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Synthesis call returned no tool_use block.");
  }

  return toolUse.input as SynthesisResult;
}
