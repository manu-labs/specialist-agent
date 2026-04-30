#!/usr/bin/env node
// Invoke a generated wrapper function from the shell.
//
//   specialist-wrapper <vendor> <function> [--key=value ...]
//
// The agent's runtime turns each step of a workflow skill into one of
// these calls. The output is JSON on stdout; non-zero exit + diagnostics
// on stderr.

import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error(
      "usage: specialist-wrapper <vendor> <function> [--key=value ...] [--tenant=path/to/tenant]",
    );
    process.exit(2);
  }

  const vendor = argv[0]!;
  const fnName = argv[1]!;
  const positional = argv.slice(2);

  let tenantPath = process.env.SPECIALIST_TENANT_PATH;
  const args: Record<string, unknown> = {};

  for (const tok of positional) {
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    const key = tok.slice(2, eq === -1 ? undefined : eq);
    const raw = eq === -1 ? "true" : tok.slice(eq + 1);
    if (key === "tenant") {
      tenantPath = raw;
      continue;
    }
    args[key] = coerce(raw);
  }

  if (!tenantPath) {
    console.error(
      "no tenant workspace specified — pass --tenant=<path> or set SPECIALIST_TENANT_PATH",
    );
    process.exit(2);
  }

  const file = path.resolve(tenantPath, "services", `${vendor}.ts`);
  const url = pathToFileURL(file).href;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (e) {
    console.error(`failed to load ${file}: ${(e as Error).message}`);
    process.exit(1);
  }

  const fn = mod[fnName];
  if (typeof fn !== "function") {
    console.error(`function "${fnName}" not exported from ${file}`);
    console.error(`exports: ${Object.keys(mod).join(", ") || "(none)"}`);
    process.exit(1);
  }

  try {
    const result = await (fn as (a: unknown) => Promise<unknown>)(args);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (e) {
    const err = e as Error & { status?: number; body?: unknown };
    console.error(`wrapper failed: ${err.message}`);
    if (err.status) console.error(`status: ${err.status}`);
    if (err.body !== undefined) {
      console.error(`body: ${typeof err.body === "string" ? err.body : JSON.stringify(err.body)}`);
    }
    process.exit(1);
  }
}

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return raw;
}

main();
