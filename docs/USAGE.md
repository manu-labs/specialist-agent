# Real-world walkthrough

End-to-end recipe for taking the specialist agent from "freshly cloned" to "running real tasks against a real API." Uses Stripe as the running example because the bundled HAR fixture targets it; the same flow works for any vendor whose API can be hit with a bearer token.

> **Cost note.** The synthesis step makes one Claude API call per `learn` invocation (input ≈ size of the trace; output ≈ size of all generated skills). With prompt caching on the system prompt, the second `learn` for the same tenant is cheaper. The `run` command is a normal Agent SDK loop — cost depends on how complex the task is. Set `ANTHROPIC_LOG=info` if you want to see request sizes.

---

## 0. Prerequisites

```bash
node --version          # ≥ 20
git --version           # ≥ 2.30
npm install
npm run typecheck       # should print nothing on success
```

Set:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Verify the safety machinery works before doing anything else:

```bash
npx tsx examples/safefs-check.ts
npx tsx examples/proving-check.ts
```

Both should end with `All ... assertions passed.` If either fails, do not continue — something in the build is wrong.

---

## 1. Capture an HTTP trace

You need a HAR file representing the workflow you want the agent to learn. Three options:

| Source                     | When to use                                              |
| -------------------------- | -------------------------------------------------------- |
| Browser DevTools (HAR)     | Web app workflows the user drives in a browser          |
| MITM proxy (mitmproxy etc.)| Native/desktop app or any traffic not in a browser      |
| `attachFetchInterceptor()` | Embedded inside a Node host that already makes the calls |

Detailed instructions per surface live in [`CAPTURE.md`](./CAPTURE.md). For this walkthrough we'll use the bundled `examples/stripe-trace.har` so you can follow along without setting up capture.

---

## 2. Synthesize skills from the trace

```bash
specialist-agent learn \
  --tenant=tenants/acme \
  --har=examples/stripe-trace.har \
  --intent="Bill a new customer for Q2 consulting fees"
```

What happens:

1. The HAR is parsed and auth headers are scrubbed (`{{auth}}` placeholders) before anything is persisted.
2. One Claude call (Opus 4.7) takes the trace + intent + your existing wrapper list and returns wrapper specs + a workflow.
3. **Parameter confirmation pass.** For each parameter on each new wrapper you'll see:

   ```
   stripe.create_invoice — parameter `currency` (string, optional)
     observed in trace: "usd"
     [k]eep as parameter / [f]reeze as constant? [k]
   ```

   Press Enter (or `k`) to keep it as a parameter. Press `f` to freeze it as a constant — the value gets inlined into the wrapper body and the parameter is dropped from the spec. Use this when the model invents a parameter that's actually a constant in your workflow (currencies, account IDs, version strings, etc.).

   Skip the prompt entirely with `--auto-keep` for non-interactive runs.

4. Each new wrapper is replay-validated (dry-run by default — confirms the function loads and exports correctly).
5. Everything commits to the tenant's git repo on a `synth/...` branch and merges to `main` if validation passes. Failed validation stays on the branch for review.

Inspect the output:

```bash
ls tenants/acme/.claude/skills/
# create_paid_invoice_for_new_customer/
# stripe.create_customer/
# stripe.create_invoice/
# stripe.create_invoiceitem/
# stripe.finalize_invoice/

cat tenants/acme/.claude/skills/create_paid_invoice_for_new_customer/SKILL.md
cat tenants/acme/services/stripe.ts
git -C tenants/acme log --oneline
# b1c2d3e synth: create_paid_invoice_for_new_customer (4 wrappers) — Bill a new customer for Q2 consulting fees
# 0ed868b init tenant workspace
```

---

## 3. Provide vendor credentials

Wrappers call out via the auth broker. The default broker reads `<VENDOR>_API_KEY` from the environment as a bearer token. For Stripe:

```bash
export STRIPE_API_KEY="sk_test_..."
```

For more elaborate auth (OAuth tokens with refresh, secrets manager lookup, multi-tenant credential isolation), wire the `SdkEmbeddedProvider` — see [`EMBEDDING.md`](./EMBEDDING.md) §"Auth providers."

---

## 4. Run the agent

```bash
specialist-agent run --tenant=tenants/acme \
  "Bill alice@example.com $500 for April consulting (30-day net terms)"
```

What you'll see (paraphrased):

```
I'll bill Alice for the consulting work using the create_paid_invoice_for_new_customer workflow.

Step 1: Create the customer.
[bash: specialist-wrapper stripe create_customer --email=... --tenant=tenants/acme]
{"id":"cus_QrSt...","object":"customer",...}

Step 2: Create the invoice.
[bash: specialist-wrapper stripe create_invoice --customer=cus_QrSt... --tenant=tenants/acme]
...

Done. Invoice in_1Ox... is open. Amount due: $500.
```

The agent loop:

1. The skill matcher picks the workflow.
2. The agent reads the workflow MD, identifies the right wrapper for each step, extracts arguments, and shells out via Bash.
3. The wrapper runs `runWrapper()`, which fetches credentials from the broker, builds the HTTP request, sends it, and returns parsed JSON on stdout.
4. The agent parses the output, extracts the values it needs (e.g. `cus_...` → next step's `customer` argument), and continues.
5. On any failure, the agent loads the wrapper's SKILL.md, the failed request/response, and prior responses, and re-reasons. Persistent drift triggers `meta.update_skill.reactive_fix`.

---

## 5. Watch the auto-rollback in action

To see the spec's "freshly merged skill that fails on first invocation auto-reverts" guardrail fire end-to-end:

```bash
# Drive the agent into making a meta-edit that breaks something.
specialist-agent run --tenant=tenants/acme --yes \
  "I noticed the create_invoice wrapper now needs a 'tax_rate' parameter. Update it to send tax_rate=0 by default and try the workflow again."

# After that turn:
cat tenants/acme/rollback.log     # entry showing the revert
git -C tenants/acme log --oneline # shows: meta: ..., then Revert "meta: ..."
```

The agent calls `meta.update_skill.update_wrapper`, which merges the change to main and marks the wrapper unproven. When the next `specialist-wrapper` invocation comes back with a non-zero exit, the `PostToolUse` hook calls `failUnproven`, which `git revert`s the bad commit and writes to `rollback.log`.

---

## 6. Inspect what was learned

```bash
# All skills
ls tenants/acme/.claude/skills/

# Workflow MD
cat tenants/acme/.claude/skills/create_paid_invoice_for_new_customer/SKILL.md

# One wrapper
cat tenants/acme/.claude/skills/stripe.create_customer/SKILL.md

# Generated TypeScript (the actual HTTP-call code)
cat tenants/acme/services/stripe.ts

# Audit log — every commit records trigger/actor/replay outcome in the message body
git -C tenants/acme log --pretty=full

# Rollbacks (if any)
cat tenants/acme/rollback.log

# Wrappers awaiting first-invocation proof (if any)
cat tenants/acme/.specialist-state.json
```

---

## 7. Iterate

The customer can teach the agent more by:

1. **Capturing more workflows.** Each `specialist-agent learn` call adds new skills. Existing wrapper skills are reused if synthesis recognizes the endpoint.
2. **Correcting mid-task.** Saying "also pass `metadata.po_number`" during a `run` triggers `meta.update_skill.update_wrapper`. The change is replay-validated and auto-reverts if the next invocation fails.
3. **Walking through a new sequence in chat.** Saying "let me show you how to onboard an enterprise customer: first call `stripe.create_customer`, then…" triggers `meta.update_skill.add_workflow`. Pure prose, no replay needed.

All three paths produce git commits with full audit trail. To roll back manually:

```bash
git -C tenants/acme revert <hash>
```

---

## Common production tasks

- **Multiple tenants:** create one workspace dir per tenant. Each is a separate git repo with its own skills, services, state, and rollback log.
- **Production credentials:** never commit them. Use the `SdkEmbeddedProvider` to resolve from your secrets manager at call time.
- **CI smoke test:** after each `learn`, run `git -C tenants/<id> diff main~1 main -- services/` to review the generated TypeScript before promoting the tenant workspace to production.
- **Disaster recovery:** the tenant workspace is a regular git repo. Mirror it to a remote and you can rebuild the entire skill set from history.

---

## What can go wrong → see [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).
