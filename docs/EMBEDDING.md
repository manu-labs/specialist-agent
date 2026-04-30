# Embedding the agent

How to host the specialist agent inside your own application (instead of driving it through the CLI).

The CLI is a thin wrapper around the public TypeScript API exported from `src/index.ts`. Anything the CLI does, your code can do.

```ts
import {
  SpecialistAgent,
  AuthBroker,
  ApiKeyProvider,
  SdkEmbeddedProvider,
  setDefaultBroker,
  importHar,
  startCapture,
  attachFetchInterceptor,
  type ParameterDecision,
} from "specialist-agent";
```

---

## Minimal lifecycle

```ts
// 1. Boot the agent for a tenant.
const agent = new SpecialistAgent({
  tenant: {
    id: "acme",
    workspacePath: "/var/lib/specialist/tenants/acme",
  },
});

// 2. (Once, after capturing a trace) — synthesize new skills.
const trace = await importHar("/tmp/onboarding.har", "Onboard enterprise customer");
const learned = await agent.learnFromTrace(trace);
console.log(`Workflow: ${learned.workflow}, wrappers: ${learned.wrappers.join(", ")}`);

// 3. Run prompts against the tenant's skills.
for await (const msg of agent.run("Onboard widgets-co with $2000 setup")) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
}
```

`SpecialistAgent` is per-tenant. Construct one per tenant; reuse it across many calls. `agent.run()` returns an async generator yielding standard Agent SDK `SDKMessage` objects — pass them to your UI streaming layer as you would for any Claude Agent SDK app.

---

## Auth providers

Wrappers ask the broker for credentials at call time. Three built-in providers:

```ts
// 1. API keys from environment (default).
//    Reads <VENDOR>_API_KEY (uppercased), e.g. STRIPE_API_KEY.
new ApiKeyProvider({ scheme: "bearer" });

// 2. Custom-header schemes (e.g. X-API-Key for some vendors).
new ApiKeyProvider({ scheme: "header", field: "X-Api-Key" });

// 3. Query-param schemes.
new ApiKeyProvider({ scheme: "query", field: "api_key" });

// 4. Host-supplied callback — credentials never sit in env.
new SdkEmbeddedProvider(async (vendor) => {
  const token = await mySecretsManager.get(`tenants/acme/${vendor}/api-key`);
  if (!token) return null;
  return { scheme: "bearer", token };
});

// 5. OAuth tokens with caller-managed refresh.
new OAuthProvider({
  get: async (vendor) => myTokenStore.get(vendor),
  refreshIfExpired: async (vendor) => myTokenStore.refresh(vendor),
});
```

Wire them up once at process boot:

```ts
import { AuthBroker, SdkEmbeddedProvider, ApiKeyProvider, setDefaultBroker } from "specialist-agent";

setDefaultBroker(
  new AuthBroker()
    // Try host-supplied first, fall back to env vars.
    .register(new SdkEmbeddedProvider(async (vendor) => {
      const token = await myVault.get(`stripe-${currentTenantId()}`);
      if (vendor === "stripe" && token) return { scheme: "bearer", token };
      return null;
    }))
    .register(new ApiKeyProvider({ scheme: "bearer" })),
);
```

Providers are tried in registration order; the first that returns `canHandle: true` wins.

**The agent never sees raw secrets at rest.** The broker is consulted at the moment of each HTTP call, inside `runWrapper()`. The token never enters the prompt or the agent's reasoning context.

---

## Confirmation hooks

Two hooks on `SpecialistAgentOptions` correspond to the spec's two human-in-the-loop points:

```ts
const agent = new SpecialistAgent({
  tenant: { id: "acme", workspacePath: "..." },

  // Spec: "Is `\"USD\"` a wrapper input or a constant?"
  // Fires once per parameter on every newly synthesized wrapper.
  confirmParameter: async ({ wrapper, parameter, observedValue }) => {
    const decision = await myUI.askConstant({
      wrapper: wrapper.name,
      parameter: parameter.name,
      observed: observedValue,
    });
    return decision === "constant"
      ? { action: "freeze", constantValue: observedValue }
      : { action: "keep" };
  },

  // Spec: "user-instructed changes require an explicit confirm step."
  // Fires when the agent calls meta.update_wrapper or meta.add_workflow.
  confirmInstructedChange: async (summary) => {
    return myUI.confirmDialog({ title: "Approve skill change?", body: summary });
  },
});
```

Both hooks default to "yes" (keep parameter / approve change) when omitted, which is what the demo and `--auto-keep` CLI mode do.

`reactive_fix` (the auto-fix-on-API-drift path) does **not** consult `confirmInstructedChange` — it applies automatically per the spec. If you want to gate that too, wrap `agent.run()` in your own approval queue.

---

## Capturing inline

When the agent is embedded inside the same process that makes the API calls, use `attachFetchInterceptor` to capture without a proxy:

```ts
import { startCapture, attachFetchInterceptor } from "specialist-agent";

async function captureAndLearn(intent: string, runWorkflow: () => Promise<void>) {
  const session = startCapture(intent);
  const stop = attachFetchInterceptor(session);
  try {
    await runWorkflow();
  } finally {
    stop();
  }
  const trace = session.finish();
  return agent.learnFromTrace(trace);
}

await captureAndLearn(
  "Onboard a new enterprise customer with first invoice",
  async () => {
    await myStripeService.createCustomer({ email: "alice@example.com" });
    await myStripeService.createInvoice({ /* ... */ });
  },
);
```

See [`CAPTURE.md`](./CAPTURE.md) for the complete capture-surface guide.

---

## Per-tenant isolation

Each tenant gets its own:

- Workspace directory (its own filesystem root)
- Git repo (its own audit history)
- Skills (no cross-tenant leakage)
- Service code (no cross-tenant leakage)
- Unproven tracker / rollback log

Constructing one `SpecialistAgent` per tenant is the right pattern. Cache them in a `Map<tenantId, SpecialistAgent>` keyed by tenant ID.

```ts
class AgentRegistry {
  private cache = new Map<string, SpecialistAgent>();

  for(tenantId: string): SpecialistAgent {
    let agent = this.cache.get(tenantId);
    if (!agent) {
      agent = new SpecialistAgent({
        tenant: {
          id: tenantId,
          workspacePath: `/var/lib/specialist/tenants/${tenantId}`,
        },
        confirmParameter: this.confirmParameter,
        confirmInstructedChange: this.confirmInstructedChange,
      });
      this.cache.set(tenantId, agent);
    }
    return agent;
  }
}
```

The agent is stateless apart from the workspace directory and the in-memory `query()` session, so it's safe to construct many — overhead is negligible.

---

## Lower-level APIs

If you want to compose the pieces yourself instead of using `SpecialistAgent`:

```ts
import {
  TenantWorkspace,
  SkillRegistry,
  synthesizeFromTrace,
  replayWrapper,
  importHar,
} from "specialist-agent";

const workspace = new TenantWorkspace({ id: "acme", workspacePath: "/var/lib/.../acme" });
await workspace.ensure();
const registry = new SkillRegistry(workspace);

const trace = await importHar("/tmp/x.har", "Bill a customer");
const result = await synthesizeFromTrace({ trace, existingWrappers: [] });

// ... apply parameter decisions yourself ...

await registry.checkoutBranch(`synth/${result.workflow.name}-${Date.now()}`);
await registry.writeSynthesisResult(result);

// Validate each wrapper.
for (const w of result.wrappers) {
  const r = await replayWrapper({
    workspace, spec: w.spec, testArgs: { /* ... */ }, dryRun: true,
  });
  if (!r.success) { /* handle */ }
}

await registry.commit({ trigger: "synthesis", actor: "human", message: "..." });
await registry.mergeToMain("synth/...");
```

This is what `SpecialistAgent.learnFromTrace` does internally, with the extra confirmation/replay/auto-rollback machinery wired up.

---

## What you cannot override

The architecture doc is strict about scope: the agent's self-modification is filesystem-scoped via `SafeFs`. Even from embedded code, you can't relax that by passing options — the allowlist is hard-coded into the workspace. If you need broader scope (e.g. you want the agent to edit its own auth broker), that's a fork-and-modify situation and you should reconsider whether you actually want it.
