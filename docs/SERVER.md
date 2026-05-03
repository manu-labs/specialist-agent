# Synthesis backend

A small HTTP server that turns a [browser-extension](../browser-extension/README.md) bundle into committed skills on the tenant's git repo. Lives at [`src/server/`](../src/server/).

```
extension → POST /v1/bundles → BundleSchema.parse → importHar →
  agent.learnFromTrace → git commit on tenant branch → 200 { workflow, wrappers, commit, traceId }
```

The server is the **only** auto-trigger for `learnFromTrace` — same code path as the CLI's `learn --bundle=...`, just wrapped in HTTP + multi-tenant auth + a Railway volume guard.

## Local development

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export RAILWAY_VOLUME_MOUNT_PATH=$PWD/.local-volume
export BUNDLE_TOKENS="dev-token:$RAILWAY_VOLUME_MOUNT_PATH/tenants/local"
mkdir -p "$RAILWAY_VOLUME_MOUNT_PATH/tenants/local"
npm run server
```

Smoke-test with the bundled fixture:

```bash
curl -X POST http://localhost:3000/v1/bundles \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  --data @test/fixtures/bundle-example.json
```

## Endpoints

### `POST /v1/bundles`

Body: a [`Bundle`](../src/bundle/schema.ts) — same shape the extension produces. Headers:

```
Authorization: Bearer <token>     (required; resolves to a tenant)
Content-Type:  application/json
```

Synchronous. Synthesis takes 30–90s for typical traces because it makes one Claude call.

```jsonc
// 200
{
  "accepted": true,
  "traceId": "5a7f3e2b-...",
  "workflow": "onboard_enterprise",
  "wrappers": ["create_customer", "create_invoice"],
  "commit": "deadbeef",
  "tenant": "acme"
}

// 400 invalid_bundle  → schema validation failed; `detail` lists the failing paths
// 401 unauthorized    → bearer missing or unknown
// 413 bundle_too_large → exceeds 50 MiB (configurable per-instance)
// 500 synthesis_failed → see `detail`
```

### `GET /healthz`

Liveness probe. Returns the configured tenant count and volume mount so misconfiguration is visible at a glance.

```jsonc
{ "status": "ok", "tenants": 3, "volumeRoot": "/data" }
```

## Configuration (env)

| Var | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Synthesis. Server refuses to start without it. |
| `RAILWAY_VOLUME_MOUNT_PATH` | yes | Persistent volume root. **Server refuses to start if any tenant path resolves outside it** — guards against ephemeral container storage silently eating tenant git history. |
| `BUNDLE_TOKENS` | yes | Bearer token → tenant-path map. Two accepted forms: <br>• CSV: `"tok-acme:/data/tenants/acme,tok-foo:/data/tenants/foo"` <br>• JSON: `'{"tok-acme":"/data/tenants/acme","tok-foo":"/data/tenants/foo"}'` |
| `PORT` | no | Defaults to `3000`. Railway sets this. |
| `SPECIALIST_MODEL` | no | Override the Claude model for synthesis. |

Volume enforcement is strict: a token mapped to `/etc/passwd` (or `/tmp/somewhere`) when `RAILWAY_VOLUME_MOUNT_PATH=/data` makes the server exit `2` at boot. No silent demotion.

## Deploy on Railway

1. **Create the project** from this repo. Railway detects the `Dockerfile` automatically.
2. **Add a volume.** Storage → New Volume, mount path `/data`. Railway sets `RAILWAY_VOLUME_MOUNT_PATH=/data` for the service.
3. **Set env vars** (Variables tab):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   BUNDLE_TOKENS={"tok-acme":"/data/tenants/acme","tok-foo":"/data/tenants/foo"}
   ```
   Pick tokens with at least 32 bytes of entropy (`openssl rand -hex 32`).
4. **Deploy.** Railway exposes a public URL like `https://specialist-server.up.railway.app`.
5. **Configure each extension user.** Options page → POST endpoint = `https://specialist-server.up.railway.app`, bearer token = the value mapped to their tenant in `BUNDLE_TOKENS`.

**Adding a tenant later:** edit `BUNDLE_TOKENS`, redeploy. The new tenant directory is created on first boot. Existing tenants are unaffected — their git history lives on the volume and survives the redeploy.

**Rotating a token:** add the new token alongside the old one in `BUNDLE_TOKENS`, redeploy, distribute, then remove the old token in a follow-up redeploy.

## Self-improvement

Every successful POST commits new wrappers + a workflow on a synth branch and merges to `main` if replay passes. The CLI runs the same agent against the same tenant repo — agent learns, git tracks, and `meta.update_skill` lets the agent reactively patch its own skills mid-task. There is no second control plane.

```bash
specialist-agent run --tenant=/data/tenants/acme "onboard a new customer at $5000 monthly"
specialist-agent log --tenant=/data/tenants/acme    # tail the audit log
```

## What's deliberately not here (yet)

- **Async synthesis + status endpoint.** v1 blocks the POST for the full Claude call. If extension users hit timeouts the next iteration is `202 Accepted` + `GET /v1/traces/:id`.
- **Per-tenant Anthropic keys.** v1 uses one platform key for all tenants.
- **Webhook on completion.** Easy to add when async lands.
- **Quotas / rate limiting.** Out of scope for v1.
