import type { HttpTrace } from "../types.js";

export const SYNTHESIS_SYSTEM_PROMPT = `You synthesize learned skills from a customer's HTTP trace.

You will be given:
1. The user's stated intent (one sentence describing what they did).
2. A scrubbed HTTP trace — request/response pairs in order, with auth values replaced by {{auth}}.
3. The set of wrapper skills the agent already has (so you can reuse them).

Your job:
- Identify which HTTP endpoints in the trace are NEW (no existing wrapper covers them) versus reused.
- For each NEW endpoint, design a thin Layer-1 wrapper skill: SKILL.md + a tiny TypeScript function body.
- Design ONE Layer-2 workflow skill (pure prose) that describes the user's task as an ordered sequence of wrapper calls.

Discipline for wrappers:
- One wrapper per endpoint. No retry logic, no response shaping, no convenience parameters. Just: build URL, inject auth, send request, return parsed response.
- Identify which values in the request are likely INPUTS (parameterize them) versus CONSTANTS (hardcode them).
- When uncertain, prefer parameterizing — humans can always confirm and freeze parameters later.
- The implementation body has access to:
    - args: the typed parameter object (already validated for required fields)
    - runWrapper(opts): a helper that wraps fetch with auth injection. Use it like:
        return runWrapper({
          vendor: "<vendor>",
          method: "POST",
          url: \`https://api.example.com/v1/things/\${args.id}\`,
          body: { name: args.name },
        });
- Wrapper names use dotted form: "<vendor>.<verb_object>", e.g. "stripe.create_invoice".
- Vendor is the apex domain's brand (stripe, github, slack, linear, asana, notion, etc.).

Discipline for the workflow:
- Pure markdown body. Reference wrappers by name, describe parameter plumbing in plain English, do NOT reproduce request/response shapes.
- The workflow name should be snake_case and reflect the user's intent (e.g. "create_paid_invoice_for_new_customer").

Return STRICT JSON matching the provided schema. No additional fields.`;

export function renderUserPrompt(args: {
  trace: HttpTrace;
  existingWrappers: Array<{ name: string; description: string }>;
}): string {
  const summary = args.trace.requests.map((ex) => {
    const url = ex.request.url;
    const method = ex.request.method;
    return {
      i: ex.index,
      method,
      url,
      status: ex.response.status,
      requestBody: ex.request.body,
      responseBody: truncateForPrompt(ex.response.body),
    };
  });

  return [
    `# Intent`,
    args.trace.intent,
    "",
    `# Existing wrapper skills (reuse if they fit)`,
    args.existingWrappers.length === 0
      ? "_(none yet)_"
      : args.existingWrappers.map((w) => `- ${w.name}: ${w.description}`).join("\n"),
    "",
    `# HTTP trace (${summary.length} exchanges)`,
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
  ].join("\n");
}

function truncateForPrompt(body: unknown): unknown {
  const s = JSON.stringify(body);
  if (s == null) return body;
  if (s.length <= 4000) return body;
  // Keep enough shape to infer the schema, drop the bulk.
  return { _truncated: true, preview: s.slice(0, 4000) };
}
