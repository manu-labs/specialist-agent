# specialist-agent

A learning agent built on the [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript) that observes customer workflows once and replays them as skills.

The full architecture is described in `docs/ARCHITECTURE.md` (the design doc this repo was built from). This README covers how the pieces fit together in code.

## What's here

```
src/
  agent.ts                  SpecialistAgent — wraps query() with tenant skills + meta tools
  types.ts                  HttpTrace, SkillMetadata, SynthesisResult, etc.
  auth/                     Pluggable auth broker (api-key, OAuth, SDK-embedded)
  capture/                  Fetch interceptor + HAR import + auth scrubbing
  synthesis/                Single Claude call: trace + intent → wrapper + workflow skills
  skills/
    registry.ts             Git-backed skill CRUD (commit/branch/merge/revert)
    meta.ts                 meta.update_skill MCP server (reactive_fix, update_wrapper, add_workflow)
  execution/
    runner.ts               runWrapper(): the only HTTP touchpoint for generated wrappers
    replay.ts               Validates a wrapper against live or staging endpoints
  tenant/workspace.ts       Per-tenant filesystem layout + git init
  cli/
    main.ts                 specialist-agent learn|run|log
    wrapper.ts              specialist-wrapper <vendor> <fn> --arg=val (the agent shells out to this)
examples/
  stripe-trace.har          Sample HAR — bills a new customer
  demo.ts                   End-to-end: import HAR → synthesize → run agent
```

## Install

```bash
npm install
```

Requires Node 20+ and an `ANTHROPIC_API_KEY` for synthesis. Per-vendor API keys (e.g. `STRIPE_API_KEY`) are read at wrapper invocation time by the auth broker.

## Quick demo

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run demo
```

This:

1. Imports `examples/stripe-trace.har` (4 Stripe API calls: create customer → create invoice → add line item → finalize).
2. Calls Claude to synthesize four wrapper skills + one workflow skill.
3. Writes them to `tenants/demo/.claude/skills/` and `tenants/demo/services/stripe.ts`.
4. Commits everything to a per-tenant git repo.

Inspect the result:

```bash
ls tenants/demo/.claude/skills/
cat tenants/demo/.claude/skills/<workflow_name>/SKILL.md
git -C tenants/demo log --oneline
```

To also exercise the agent loop against the synthesized skills, set `RUN_AGENT=1` and provide `STRIPE_API_KEY`.

## CLI

```bash
# Learn from a HAR export of an observed task.
specialist-agent learn \
  --tenant=tenants/acme \
  --har=./acme-onboarding.har \
  --intent="Onboard a new enterprise customer with first invoice"

# Run the agent against the tenant's learned skills.
specialist-agent run --tenant=tenants/acme "Onboard widgets-co with $2000 setup"

# Tail the audit log (just `git log` over the skill repo).
specialist-agent log --tenant=tenants/acme
```

## Embedding

Use the `SpecialistAgent` class to host the agent inside your own application:

```ts
import {
  SpecialistAgent,
  AuthBroker,
  SdkEmbeddedProvider,
  setDefaultBroker,
} from "specialist-agent";

// Wire your own credential resolution — the agent never sees raw secrets at rest.
setDefaultBroker(
  new AuthBroker().register(
    new SdkEmbeddedProvider(async (vendor) => {
      if (vendor === "stripe") return { scheme: "bearer", token: await myVault.get("stripe") };
      return null;
    }),
  ),
);

const agent = new SpecialistAgent({
  tenant: { id: "acme", workspacePath: "/var/lib/specialist/tenants/acme" },
  confirmInstructedChange: async (summary) => myUI.confirm(summary),
});

for await (const msg of agent.run("Bill alice@example.com $500 for April")) {
  // stream messages to your UI
}
```

## How a task runs

1. The agent's system prompt describes the two-layer skill model and gives it the wrapper CLI invocation format.
2. The Agent SDK loads tenant skills from `.claude/skills/<name>/SKILL.md` via `settingSources: ["project"]` with `cwd` set to the tenant root.
3. The skill matcher picks the best workflow (or wrapper, for atomic asks).
4. The agent reads the workflow MD, identifies the right wrapper for each step, and shells out via `Bash`:

   ```
   npx tsx src/cli/wrapper.ts stripe create_customer --email=alice@example.com --name=Alice --tenant=tenants/acme
   ```

5. The wrapper imports `services/stripe.ts`, calls the named function, and prints JSON on stdout. The function uses `runWrapper()`, which delegates auth to the broker.
6. If a wrapper call fails or returns an unexpected shape, the agent loads the wrapper's MD, the failure, and prior responses, then re-reasons. If the failure looks like persistent drift (not transient), it invokes `meta.update_skill.reactive_fix` to update the wrapper and replay-validate the change before merging.

## Capture surfaces

The architecture doc lists three: browser extension, MITM proxy, and SDK interceptor. This repo ships:

- **`attachFetchInterceptor(session)`** — patches `globalThis.fetch` for the Node SDK-embedded path.
- **`importHar(path, intent)`** — drop-in for browser DevTools / proxy / extension exports.

Auth headers and obvious credential keys are scrubbed at capture time (`src/capture/scrub.ts`); nothing sensitive is persisted.

## Self-updating skills (meta tools)

The agent's runtime exposes three tools via the `specialist-meta` MCP server:

| Tool             | Trigger                                       | Confirmation         | Validation                    |
| ---------------- | --------------------------------------------- | -------------------- | ----------------------------- |
| `reactive_fix`   | Wrapper call failed with persistent drift     | Auto                 | Replay; merge only on success |
| `update_wrapper` | User instruction mid-task                     | Required (host hook) | Replay; merge only on success |
| `add_workflow`   | User walks through a sequence in conversation | Required (host hook) | None (pure prose)             |

Failed validations stay on a branch (`synth/...`, `meta/...`) so the host can review.

## What's deliberately not here

Per the architecture doc:

- **No frame/screen capture.** HTTP is the source of truth for v1.
- **No streaming relevance filter.** Filtering happens at synthesis time on the trimmed trace.
- **No multi-recording parameter inference.** A single trace + a confirmation pass handles ambiguity.
- **No smart wrapper functions.** Wrappers stay thin. Logic lives in workflows or agent reasoning.
- **No self-modification beyond skills.** The meta tools cannot touch the auth broker, the runtime, or themselves — only files under the tenant workspace's `.claude/skills/` and `services/`.

## Scripts

```bash
npm run typecheck     # tsc --noEmit
npm run build         # emit dist/
npm run demo          # examples/demo.ts
```
