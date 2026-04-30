# Capturing HTTP traces

The agent learns from HTTP traces. The architecture doc lists three capture surfaces; this repo ships full support for two and a recipe for the third.

| Surface             | What for                                              | Status                            |
| ------------------- | ----------------------------------------------------- | --------------------------------- |
| Browser DevTools HAR| Web-app workflows the user drives in a browser       | Use `importHar()` / `--har=...`   |
| MITM proxy HAR      | Native/desktop apps, mobile apps, anything not in DevTools | Use `importHar()` / `--har=...` |
| `attachFetchInterceptor()` | Embedded inside a Node host that already makes the calls | First-class API in `src/capture/` |

All three produce the same in-memory `HttpTrace` shape (see `src/types.ts`). Auth headers and obvious credential keys are scrubbed at capture time (`src/capture/scrub.ts`) — nothing sensitive is persisted.

---

## Surface 1: Browser DevTools (recommended for web SaaS)

This is the easiest path for SaaS apps.

1. Open your app in Chrome, Firefox, or Edge.
2. Open DevTools (F12) → **Network** tab.
3. Tick **Preserve log** so navigation doesn't clear the trace.
4. Click **🚫** (clear) to start fresh.
5. Perform the workflow you want the agent to learn — ideally once, end-to-end, no extra exploration.
6. Right-click anywhere in the network list → **Save all as HAR with content** → save as e.g. `~/Downloads/onboarding.har`.
7. Run synthesis:

   ```bash
   specialist-agent learn \
     --tenant=tenants/acme \
     --har=~/Downloads/onboarding.har \
     --intent="Onboard a new enterprise customer with first invoice"
   ```

**Tips:**

- **Filter to the relevant API host** before saving. Click **Filter** and type the API hostname (e.g. `api.stripe.com`) so you don't include analytics, fonts, telemetry, etc. The model can ignore noise but smaller traces synthesize faster and cheaper.
- **One workflow per HAR.** Don't bundle "create customer" and "process refund" into one trace — synthesize them separately.
- **Auth is automatically scrubbed.** `Authorization`, `Cookie`, `X-Api-Key`, etc. become `{{auth}}` before anything hits disk.

---

## Surface 2: MITM proxy

For non-browser apps (desktop, native, mobile, server-to-server). Common tools:

- [mitmproxy](https://mitmproxy.org/) — open source, scriptable
- [Charles Proxy](https://www.charlesproxy.com/)
- [Proxyman](https://proxyman.io/)

### mitmproxy recipe

```bash
# 1. Start mitmproxy and tell the target app to use it.
mitmproxy --listen-port 8080

# 2. Trust the mitmproxy CA on the device running the workflow (one-time).
#    See https://docs.mitmproxy.org/stable/concepts-certificates/

# 3. Set HTTPS_PROXY / HTTP_PROXY for the target process.
HTTPS_PROXY=http://localhost:8080 ./your-app

# 4. Perform the workflow.

# 5. Export the captured flows as HAR.
#    In mitmproxy's UI: File → Save → HAR (>1.5 only). On older versions,
#    use the bundled har_dump addon:
mitmproxy --listen-port 8080 -s ~/path/to/har_dump.py --set hardump=onboarding.har

# 6. Run synthesis with the exported HAR — same as the DevTools path.
specialist-agent learn --tenant=tenants/acme --har=./onboarding.har --intent="..."
```

### Charles Proxy

File → Export Session → HAR.

### Proxyman

File → Export → HAR.

---

## Surface 3: SDK fetch interceptor (embedded use)

When the agent is embedded inside a Node host that *already* makes the API calls (e.g. an internal automation service), capture happens inline. No external proxy or browser needed.

```ts
import { startCapture, attachFetchInterceptor, SpecialistAgent } from "specialist-agent";

const session = startCapture("Onboard a new enterprise customer with first invoice");
const stop = attachFetchInterceptor(session);

try {
  // Drive the workflow through your normal code path. Every fetch() call
  // — directly or via SDKs that use fetch() under the hood — is recorded.
  await myStripeService.createCustomer({ email: "alice@example.com" });
  await myStripeService.createInvoice({ /* ... */ });
  // ...
} finally {
  stop(); // restore the original fetch
}

const trace = session.finish();

// Hand the trace to the agent for synthesis.
const agent = new SpecialistAgent({
  tenant: { id: "acme", workspacePath: "/var/lib/specialist/tenants/acme" },
});
const result = await agent.learnFromTrace(trace);
console.log(`Synthesized: ${result.workflow}, ${result.wrappers.length} wrappers`);
```

The interceptor:

- Patches `globalThis.fetch` for the duration of the capture session.
- Reads request method/URL/headers/body.
- Reads response status/headers/body (clones the response so the caller still gets a fresh body).
- Stops automatically when you call `stop()`. Always call it (e.g. in a `finally`) so subsequent fetches aren't intercepted.

**What it does not capture:**

- HTTP calls made via Node's `http`/`https` modules directly (most SDKs use fetch in modern Node, but some old ones don't).
- Calls from a child process. Re-launch with the interceptor, or use a MITM proxy.

---

## Anatomy of an `HttpTrace`

All three surfaces produce this shape:

```ts
interface HttpTrace {
  id: string;
  startedAt: string;       // ISO 8601
  endedAt: string;
  intent: string;          // one-sentence task description
  requests: HttpExchange[];
}

interface HttpExchange {
  index: number;
  request: {
    method: string;        // GET, POST, ...
    url: string;
    headers: Record<string, string>;  // auth values are {{auth}}
    body: unknown;         // parsed JSON if Content-Type was JSON, else string
    timestamp: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
  };
}
```

You can construct an `HttpTrace` directly if you have a non-standard capture source — synthesis only cares about the shape.

---

## Auth scrubbing

The scrubber (`src/capture/scrub.ts`) replaces:

- **Headers** named: `authorization`, `x-api-key`, `api-key`, `x-auth-token`, `x-access-token`, `cookie`, `set-cookie`, `proxy-authorization`.
- **JSON keys** matching: `api_key`, `apikey`, `access_token`, `refresh_token`, `client_secret`, `password`, `secret`.
- **String bodies** containing `Bearer <token>` patterns.

This is a heuristic — not a guarantee. Synthesis is the second line of defense; it never echoes credential-shaped values into generated wrappers because of how the prompt frames the task. If you have unusual auth schemes (custom header names, etc.), extend `AUTH_HEADER_NAMES` in `scrub.ts`.

---

## What makes a good capture

- **One task end-to-end.** Don't bundle multiple workflows.
- **Minimal exploration.** The trace should reflect the *successful* path, not all the false starts.
- **No retries with old auth.** If the user has expired tokens that triggered a refresh in the middle of capture, separate the refresh into its own learn call (or remove those exchanges from the HAR before synthesis).
- **One vendor per call.** Don't capture a workflow that hits both Stripe and Slack and try to synthesize one workflow. Synthesize a Stripe workflow and a Slack workflow separately, then capture a higher-level workflow that *composes* them — the agent will discover the existing wrappers and stitch them.
