// Pure synthesis handler: validated bundle + resolved tenant → result.
// No HTTP concerns here so it's trivially unit-testable.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SpecialistAgent } from "../agent.js";
import { importHar } from "../capture/har.js";
import type { Bundle } from "../bundle/schema.js";
import type { TenantConfig } from "../types.js";

export interface SynthesisOk {
  ok: true;
  accepted: true;
  traceId: string;
  workflow: string;
  wrappers: string[];
  commit: string;
  tenant: string;
}

export interface SynthesisErr {
  ok: false;
  status: number;
  error: string;
  detail: string;
}

export type SynthesisResult = SynthesisOk | SynthesisErr;

export interface HandlerDeps {
  /**
   * Factory so tests can stub the agent. Production wires
   * `(t) => new SpecialistAgent({ tenant: t, ... })`.
   */
  agentFor: (tenant: TenantConfig) => Pick<SpecialistAgent, "learnFromTrace">;
}

/**
 * Parse the bundle's HAR, hand it to the tenant's agent for synthesis,
 * and return the names of the workflow + wrappers that were committed.
 * `learnUrl` is left for the host to derive (e.g. Railway preview URL +
 * `/v1/traces/<id>`); not produced here.
 */
export async function processBundle(
  bundle: Bundle,
  tenant: TenantConfig,
  deps: HandlerDeps,
): Promise<SynthesisResult> {
  const traceId = randomUUID();
  const tmpFile = path.join(os.tmpdir(), `specialist-bundle-${traceId}.har`);

  try {
    await fs.writeFile(tmpFile, JSON.stringify(bundle.har));
    const trace = await importHar(tmpFile, bundle.intent);
    if (bundle.narrative) {
      trace.intent = `${bundle.intent}\n\n[narration: ${bundle.narrative}]`;
    }
    trace.id = traceId;

    const agent = deps.agentFor(tenant);
    const result = await agent.learnFromTrace(trace, { skipReplay: false });

    return {
      ok: true,
      accepted: true,
      traceId,
      workflow: result.workflow,
      wrappers: result.wrappers,
      commit: result.commit,
      tenant: tenant.id,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: "synthesis_failed",
      detail: (err as Error).message,
    };
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}
