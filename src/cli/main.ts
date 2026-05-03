#!/usr/bin/env node
// Top-level CLI for the specialist agent.
//
//   specialist-agent learn  --tenant=<path> --har=<file> --intent="..."
//   specialist-agent run    --tenant=<path> "<prompt>"
//   specialist-agent log    --tenant=<path>
//
// The "learn" command runs synthesis end-to-end: HAR → skills → commit.
// The "run" command starts a Claude Agent SDK session against the tenant's
// skill set. "log" tails the git history of skill changes.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { SpecialistAgent } from "../agent.js";
import { TenantWorkspace } from "../tenant/workspace.js";
import { importHar } from "../capture/har.js";
import { BundleSchema } from "../bundle/schema.js";
import type { HttpTrace, ParameterDecision } from "../types.js";

interface Flags {
  tenant?: string;
  har?: string;
  bundle?: string;
  intent?: string;
  model?: string;
  yes?: boolean;
  /** Skip the parameter-confirmation prompt and keep all parameters. */
  "auto-keep"?: boolean;
  positional: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { positional: [] };
  for (const tok of argv) {
    if (!tok.startsWith("--")) {
      f.positional.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const key = tok.slice(2, eq === -1 ? undefined : eq);
    const val = eq === -1 ? "true" : tok.slice(eq + 1);
    (f as unknown as Record<string, unknown>)[key] = val === "true" ? true : val;
  }
  return f;
}

async function cmdLearn(flags: Flags): Promise<void> {
  if (!flags.tenant) die("missing --tenant=<path>");
  if (flags.bundle && flags.har) die("--bundle and --har are mutually exclusive");
  if (flags.bundle && flags.intent) {
    die("--intent collides with bundle.intent; remove --intent or omit --bundle");
  }
  if (!flags.bundle && !flags.har) {
    die("missing --bundle=<file> (extension capture) or --har=<file> + --intent=\"...\"");
  }
  if (flags.har && !flags.intent) die("missing --intent=\"<one-sentence task description>\"");

  const trace: HttpTrace = flags.bundle
    ? await loadBundleTrace(flags.bundle)
    : await importHar(flags.har!, flags.intent!);
  const agent = new SpecialistAgent({
    tenant: { id: path.basename(flags.tenant!), workspacePath: path.resolve(flags.tenant!) },
    ...(flags.model ? { model: flags.model } : {}),
    confirmParameter: flags["auto-keep"]
      ? async () => ({ action: "keep" }) as ParameterDecision
      : async ({ wrapper, parameter, observedValue }) => {
          const observed = renderObserved(observedValue);
          console.log(
            `\n${wrapper.name} — parameter \`${parameter.name}\` (${parameter.type}, ${parameter.required ? "required" : "optional"})`,
          );
          console.log(`  observed in trace: ${observed}`);
          const ans = (await promptText("  [k]eep as parameter / [f]reeze as constant? [k] ")).toLowerCase();
          if (ans === "f" || ans === "freeze") {
            return { action: "freeze", constantValue: observedValue };
          }
          return { action: "keep" };
        },
  });
  const result = await agent.learnFromTrace(trace, { skipReplay: false });

  console.log(`\nSynthesized workflow: ${result.workflow}`);
  console.log(`Wrappers: ${result.wrappers.join(", ") || "(none new)"}`);
  if (result.commit) console.log(`Commit: ${result.commit.slice(0, 12)}`);
}

async function loadBundleTrace(bundlePath: string): Promise<HttpTrace> {
  const raw = await fs.readFile(bundlePath, "utf8");
  const bundle = BundleSchema.parse(JSON.parse(raw));
  const tmp = path.join(os.tmpdir(), `specialist-bundle-${Date.now()}.har`);
  await fs.writeFile(tmp, JSON.stringify(bundle.har));
  try {
    const trace = await importHar(tmp, bundle.intent);
    if (bundle.narrative) {
      trace.intent = `${bundle.intent}\n\n[narration: ${bundle.narrative}]`;
    }
    return trace;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

function renderObserved(value: unknown): string {
  if (value === undefined) return "(none)";
  if (value === null) return "null";
  const s = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

async function cmdRun(flags: Flags): Promise<void> {
  if (!flags.tenant) die("missing --tenant=<path>");
  const prompt = flags.positional.join(" ").trim();
  if (!prompt) die("usage: specialist-agent run --tenant=<path> \"<prompt>\"");

  const agent = new SpecialistAgent({
    tenant: { id: path.basename(flags.tenant!), workspacePath: path.resolve(flags.tenant!) },
    ...(flags.model ? { model: flags.model } : {}),
    confirmInstructedChange: flags.yes
      ? async () => true
      : async (summary) => promptUser(`The agent wants to apply: "${summary}". Confirm? [y/N] `),
  });

  for await (const msg of agent.run(prompt)) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
    } else if (msg.type === "result") {
      process.stdout.write(`\n\n[done — cost $${msg.total_cost_usd.toFixed(4)}, turns ${msg.num_turns}]\n`);
    }
  }
}

async function cmdLog(flags: Flags): Promise<void> {
  if (!flags.tenant) die("missing --tenant=<path>");
  const ws = new TenantWorkspace({
    id: path.basename(flags.tenant!),
    workspacePath: path.resolve(flags.tenant!),
  });
  await ws.ensure();
  const { stdout } = await ws.git("log", "--pretty=format:%h  %s%n  %b", "-n", "30");
  process.stdout.write(stdout + "\n");
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function promptUser(q: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

function promptText(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "learn":
      return cmdLearn(flags);
    case "run":
      return cmdRun(flags);
    case "log":
      return cmdLog(flags);
    default:
      console.error("usage: specialist-agent <learn|run|log> [flags]");
      console.error("  learn --tenant=<path> (--bundle=<file> | --har=<file> --intent=\"...\") [--auto-keep]");
      console.error("  run   --tenant=<path> [--yes] \"<prompt>\"");
      console.error("  log   --tenant=<path>");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
