# Troubleshooting

Common errors during synthesis, replay, and run.

---

## Synthesis

### `AuthenticationError: 401 ... invalid x-api-key`

`ANTHROPIC_API_KEY` is missing or wrong. The key is read at the moment `synthesizeFromTrace` makes its call, not at agent construction time.

```bash
echo "$ANTHROPIC_API_KEY"   # should print sk-ant-...
```

### `Synthesis call returned no tool_use block.`

The model produced text instead of invoking the schema. Causes:

- Trace is empty (HAR contains no exchanges, or every exchange got filtered).
- Trace is enormous and the model refused. Filter to only the relevant API host before exporting.
- Quota / rate limit. Check `https://status.anthropic.com` and your usage dashboard.

### Generated wrappers reference parameters the trace doesn't actually use

This is what the parameter-confirmation pass exists for. Synthesis sometimes invents parameters that look reasonable from one trace but are constants in your workflow. Run `learn` interactively (without `--auto-keep`), and freeze the spurious parameters when prompted.

If you already merged a wrapper with a bogus parameter, ask the agent to fix it: `specialist-agent run --tenant=... "Update stripe.create_invoice — drop the 'foo' parameter, it should always be 'bar'"`. The agent will call `meta.update_skill.update_wrapper`, you confirm the summary, and it's replay-validated and merged.

---

## Replay validation

### `function "<name>" not exported from <file>`

The model emitted an `implementation` block that doesn't map to a single exported function — usually because the wrapper name has unusual characters. Wrapper names use dotted form (`<vendor>.<verb_object>`) and the function name is the part after the last dot. Inspect `services/<vendor>.ts`, find the actual export, and compare to the SKILL.md.

### `failed to load <file>: SyntaxError: ...`

Synthesis emitted invalid TypeScript. Rare but possible. The `synth/...` branch will retain the broken file; merge to main was blocked. Fix the file by hand on the branch, push, and merge:

```bash
git -C tenants/<id> checkout synth/<workflow>-<timestamp>
# fix services/<vendor>.ts
git -C tenants/<id> commit -am "fix: synthesized wrapper had a syntax error"
git -C tenants/<id> checkout main
git -C tenants/<id> merge --ff-only synth/<workflow>-<timestamp>
```

Then ping the issue tracker — repeated occurrences mean the synthesis prompt needs tightening.

---

## Agent run

### Agent picks the wrong skill

The Skill tool selects based on the description in each SKILL.md frontmatter. If the agent keeps choosing the wrong workflow, the descriptions are too similar or too generic. Edit `.claude/skills/<name>/SKILL.md` and tighten the `description:` line — make sure the "Use when:" portion is concrete and distinguishing. Commit the change directly:

```bash
git -C tenants/<id> commit -am "tighten description for <workflow>"
```

### `wrapper failed: <vendor> ... 401 Unauthorized`

The auth broker returned a credential, but the vendor rejected it. Check:

- `<VENDOR>_API_KEY` env var is set (or your `SdkEmbeddedProvider` returns one).
- The token has the necessary scopes.
- The token isn't expired (for OAuth tokens — the `OAuthProvider.refreshIfExpired` callback should handle this).

### Auto-rollback fired when it shouldn't have

If the wrapper's first post-meta-merge call returned non-zero exit, the rollback hook reverted. Check `tenants/<id>/rollback.log` — the entry will say what the failure looked like. Common causes:

- Transient 5xx — should not have triggered rollback. The wrapper CLI exits non-zero on any error; we don't yet distinguish transient from permanent. If this is recurrent, file an issue.
- The user-instructed change actually broke things — the rollback was correct.
- The "first invocation" was a wrapper call from a *different* run that happened to fail for an unrelated reason. The unproven tracker is keyed by wrapper name, not session ID.

To re-attempt the change: `specialist-agent run --tenant=... "Re-apply the change to <wrapper> — ..."`. The agent will call `meta.update_skill.update_wrapper` again and re-mark unproven.

### `git revert` failed during auto-rollback

Means the unproven commit had already been further modified (e.g. another meta-edit landed on top before the first invocation). `failUnproven` will throw; the rollback log won't have an entry. Inspect manually:

```bash
git -C tenants/<id> log --oneline
git -C tenants/<id> revert <hash>     # interactively resolve
```

This is a rare edge case — meta-edits to the same wrapper in rapid succession.

---

## SafeFs / scope violations

### `ScopeViolationError: path "..." is not in the SafeFs allowlist`

The agent (or your code) tried to write somewhere outside the allowlisted prefixes. This is the guardrail working as intended — investigate what the call site was trying to do.

If you're writing legitimate host-side state that the agent shouldn't touch, store it *outside* the tenant workspace. The allowlist exists to prevent the agent from escaping; host code should respect the same boundary by storing its own state elsewhere.

If you have a genuine reason to extend the allowlist (e.g. the agent writes generated test fixtures to `tests/` in the tenant workspace), add the prefix in `src/skills/safe-fs.ts:assertWithin`. Be conservative — every prefix added is one more place the agent can write under prompt injection.

---

## Capture

### HAR import skips entries silently

`importHar` handles standard HAR 1.2. If your tool exports a non-standard variant (some MITM proxies' HAR has missing fields), check the import:

```ts
import { importHar } from "specialist-agent";
const trace = await importHar("/tmp/x.har", "...");
console.log(`${trace.requests.length} exchanges imported`);
```

If the count is lower than expected, inspect the raw HAR for missing required fields (`startedDateTime`, `request.method`, `request.url`, `response.status`).

### Fetch interceptor doesn't capture some calls

`attachFetchInterceptor` patches `globalThis.fetch`. It does NOT capture:

- Calls via Node's `http`/`https` modules directly.
- Calls from a worker thread (each thread has its own `globalThis`).
- Calls from a child process.

For these, use a MITM proxy (see `CAPTURE.md`).

### Auth scrubbing missed something sensitive

`src/capture/scrub.ts` is heuristic. Expand the header list or the JSON-key regex if your vendor uses a non-standard credential shape, and verify by inspecting the trace before synthesis:

```ts
const trace = await importHar("/tmp/x.har", "...");
console.log(JSON.stringify(trace, null, 2));
```

Synthesis is the second line of defense — the prompt is structured so the model treats `{{auth}}` as opaque and never echoes raw values. But if you see real credentials in the trace, fix the scrubber before running synthesis.

---

## Build / install

### `Cannot find name 'RequestInfo'` etc. on typecheck

`tsconfig.json` lib must include `DOM` for the fetch interceptor's types. The repo's tsconfig already does this; if you're embedding from another project with a different config, add:

```json
"lib": ["ES2023", "DOM"]
```

### `npm install` fails fetching `@anthropic-ai/claude-agent-sdk`

Make sure your registry config can reach `registry.npmjs.org`. The package isn't private.

### `npx tsx` warns about `punycode` deprecation

Cosmetic. Comes from a transitive dependency in Node 22+. Ignore.

---

## Where to look when something else breaks

1. **Tenant git log.** Every skill change records trigger / actor / replay outcome in the commit message body. `git -C tenants/<id> log --pretty=full` is the audit trail.
2. **rollback.log.** If the proving tracker reverted something, here's why.
3. **`.specialist-state.json`.** Lists wrappers currently flagged as unproven (waiting for first-invocation proof).
4. **Set `ANTHROPIC_LOG=info`.** SDK-level request logging from `@anthropic-ai/sdk`.
5. **Run with one wrapper.** Edit a HAR down to one exchange to isolate which wrapper is misbehaving.

If you've narrowed the problem and it still doesn't make sense, file an issue with: tenant id (or anonymized snippet of `git log`), the synthesis output that produced the wrapper, the failing prompt, and any relevant `rollback.log` entries.
