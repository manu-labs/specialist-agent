# specialist-agent

A learning agent built on the [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript) that observes customer workflows once and replays them as skills.

## Documentation

| Doc                                       | What's in it                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| **This file**                             | Quickstart, install, project layout, scripts                            |
| [`docs/USAGE.md`](docs/USAGE.md)          | End-to-end real-world walkthrough — capture → synthesize → run          |
| [`docs/CAPTURE.md`](docs/CAPTURE.md)      | Four ways to capture HTTP traces: DevTools HAR, browser extension, MITM proxy, SDK hook |
| [`browser-extension/README.md`](browser-extension/README.md) | Chrome MV3 extension that captures workflows and emits a bundle file the host CLI consumes via `--bundle=` |
| [`docs/SERVER.md`](docs/SERVER.md)        | Multi-tenant synthesis backend (`src/server/`) — receives bundles from the extension, runs `learnFromTrace`, commits to the tenant repo. Railway-deployable. |
| [`docs/EMBEDDING.md`](docs/EMBEDDING.md)  | Programmatic API for embedding the agent in your own host application  |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Common errors and fixes                                       |
| [`prompts/`](prompts/)                    | Briefing prompts for follow-up planning agents (next features)          |

## Install

```bash
npm install
```

Requires Node 20+. Set `ANTHROPIC_API_KEY` for synthesis. Per-vendor API keys (e.g. `STRIPE_API_KEY`) are read at wrapper invocation time by the auth broker.

## 60-second quickstart

```bash
# 1. Verify the build works.
npm run typecheck

# 2. Verify the safety guardrails.
npx tsx examples/safefs-check.ts    # scope enforcement
npx tsx examples/proving-check.ts   # auto-rollback

# 3. Run the synthesis demo against the bundled Stripe HAR.
ANTHROPIC_API_KEY=sk-ant-... npm run demo
```

The demo synthesizes wrapper + workflow skills from `examples/stripe-trace.har` (a 4-call invoice flow) and commits them to `tenants/demo/`. After it runs:

```bash
ls tenants/demo/.claude/skills/
cat tenants/demo/.claude/skills/<workflow_name>/SKILL.md
git -C tenants/demo log --oneline
```

To exercise the full agent loop (synthesis → run prompt → execute wrappers → call live Stripe), see [`docs/USAGE.md`](docs/USAGE.md).

## Project layout

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
    safe-fs.ts              Filesystem allowlist gate (scope enforcement)
    proving.ts              Unproven tracker — auto-rollback on first-call failure
  execution/
    runner.ts               runWrapper(): the only HTTP touchpoint for generated wrappers
    replay.ts               Validates a wrapper against live or staging endpoints
  tenant/workspace.ts       Per-tenant filesystem layout + git init
  cli/
    main.ts                 specialist-agent learn|run|log
    wrapper.ts              specialist-wrapper <vendor> <fn> --arg=val (the agent shells out to this)
examples/
  stripe-trace.har          Sample HAR — bills a new customer
  demo.ts                   End-to-end: import HAR → synthesize → commit
  safefs-check.ts           SafeFs scope-rejection assertions
  proving-check.ts          Auto-rollback tracker assertions
docs/
  USAGE.md                  Real-world walkthrough
  CAPTURE.md                Capture surfaces
  EMBEDDING.md              Host integration
  TROUBLESHOOTING.md        Common errors
```

## CLI reference

```bash
# Synthesize skills from an observed task.
# Either pass a HAR (with --intent) or a bundle from the browser extension.
specialist-agent learn \
  --tenant=tenants/<id> \
  (--bundle=./bundle.json | --har=./<file>.har --intent="<one-sentence description>") \
  [--auto-keep]                 # skip parameter-confirmation prompt

# Run the agent against the tenant's learned skills.
specialist-agent run --tenant=tenants/<id> [--yes] "<prompt>"

# Tail the audit log (just `git log` over the skill repo).
specialist-agent log --tenant=tenants/<id>
```

## Architecture summary

Two-layer skills:

- **Layer 1 — wrappers.** One per HTTP endpoint observed during learning. `SKILL.md` describes when to use it and what it returns; a thin TypeScript function under `services/<vendor>.ts` builds the URL, injects auth, and returns the parsed response. Invoked by the agent via shell with `specialist-wrapper`.
- **Layer 2 — workflows.** Pure markdown describing how to compose wrappers. The agent reads the workflow MD and orchestrates calls itself.

Self-updating: the agent has a `meta.update_skill` MCP server with three tools (`reactive_fix`, `update_wrapper`, `add_workflow`) that let it modify its own skill set. Every change is a git commit on a per-tenant repo.

| Guardrail                | Where                                            |
| ------------------------ | ------------------------------------------------ |
| Scope enforcement        | `src/skills/safe-fs.ts` — path allowlist         |
| Replay before merge      | `src/execution/replay.ts` — gate on `mergeToMain`|
| Auto-rollback            | `src/skills/proving.ts` + `PostToolUse` hooks    |
| Confirmation pass        | `confirmParameter` hook + CLI prompt             |
| Audit log                | `git log` over the tenant repo + `rollback.log`  |

## Scripts

```bash
npm run typecheck                       # tsc --noEmit
npm run build                           # emit dist/
npm run demo                            # examples/demo.ts
npx tsx examples/safefs-check.ts        # scope assertions
npx tsx examples/proving-check.ts       # rollback assertions
```

## What's deliberately not here

Per the architecture doc:

- **No frame/screen capture.** HTTP is the source of truth for v1.
- **No streaming relevance filter.** Filtering happens at synthesis time.
- **No multi-recording parameter inference.** A single trace + confirmation pass handles ambiguity.
- **No smart wrapper functions.** Wrappers stay thin. Logic lives in workflows or agent reasoning.
- **No self-modification beyond skills.** Meta tools cannot touch auth, runtime, or themselves — enforced by `SafeFs`.
