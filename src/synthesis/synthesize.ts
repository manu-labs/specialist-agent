import Anthropic from "@anthropic-ai/sdk";
import type {
  HttpTrace,
  ParameterDecision,
  SynthesisResult,
  WrapperSpec,
} from "../types.js";
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
            observedValues: {
              type: "object",
              description:
                "Per-parameter sample values pulled from the trace. Keys are parameter names; values are the literal observed in the request. Used to drive a 'is this a constant?' confirmation pass with the user.",
              additionalProperties: true,
            },
          },
          required: ["spec", "implementation", "observedValues"],
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

/**
 * Apply the host's parameter decisions to one wrapper. Each `freeze`
 * decision drops the parameter from `spec.parameters`, inlines its constant
 * into both the `urlTemplate` and the implementation source, and updates
 * the description string in the SKILL.md so the wrapper accurately reflects
 * what the agent will see at invocation time.
 *
 * Returns a new spec + implementation. Inputs are not mutated.
 */
export function applyParameterDecisions(args: {
  spec: WrapperSpec;
  implementation: string;
  decisions: Record<string, ParameterDecision>;
}): { spec: WrapperSpec; implementation: string } {
  let urlTemplate = args.spec.http.urlTemplate;
  let implementation = args.implementation;
  const remaining: typeof args.spec.parameters = [];

  for (const param of args.spec.parameters) {
    const decision = args.decisions[param.name] ?? { action: "keep" };
    if (decision.action === "keep") {
      remaining.push(param);
      continue;
    }
    const literal = formatLiteral(decision.constantValue, param.type);
    const stringLiteral = stringFormOf(decision.constantValue);

    // {arg} placeholders in the URL template are inlined as plain strings.
    urlTemplate = urlTemplate.split(`{${param.name}}`).join(stringLiteral);
    urlTemplate = urlTemplate.split(`\${args.${param.name}}`).join(stringLiteral);

    // args.foo references in the function body become literal expressions.
    // Order matters: the longer template-literal form first.
    implementation = implementation.split(`\${args.${param.name}}`).join(stringLiteral);
    implementation = implementation
      .split(new RegExp(`\\bargs\\.${escapeRegex(param.name)}\\b`))
      .join(literal);
  }

  return {
    spec: {
      ...args.spec,
      parameters: remaining,
      http: { ...args.spec.http, urlTemplate },
    },
    implementation,
  };
}

function formatLiteral(value: unknown, type: WrapperSpec["parameters"][number]["type"]): string {
  switch (type) {
    case "string":
      return JSON.stringify(typeof value === "string" ? value : String(value));
    case "number":
      return String(typeof value === "number" ? value : Number(value));
    case "boolean":
      return String(Boolean(value));
    default:
      // Object/structured: serialize and trust the implementation context.
      return JSON.stringify(value);
  }
}

function stringFormOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
