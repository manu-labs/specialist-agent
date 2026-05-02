# Browser extension: third capture surface for `specialist-agent`

> **Status:** plan, not implementation.
> **Owner:** TBD.
> **Source prompt:** `prompts/plan-browser-extension.md`.

## 0. Decisions to confirm with user

| # | Decision | Default | Rationale |
| --- | --- | --- | --- |
| D1 | Voice transcription | Web Speech API (Chrome) + Whisper.wasm fallback | Free + zero bundle on Chrome; Whisper opt-in for Firefox/offline |
| D2 | Bundle trace format | HAR 1.2 | `importHar` already parses it; universal interop |
| D3 | Build tool | Vite + `@crxjs/vite-plugin` | Native MV3 awareness, HMR, multi-entry |
| D4 | v1 browser scope | Chrome-only v1; Firefox v1.1 | CDP + offscreen doc are Chrome-stable; Firefox needs separate adapter |
| D5 | `--bundle` + `--intent` set together | Hard error | Surface user error |
| D6 | `--bundle` + `--har` set together | Hard error | Mutually exclusive |

If the user disagrees on any of these, stop before implementation.

## 1. Architecture

### 1.1 Components

| Component | Lives in | Lifetime | Responsibilities |
| --- | --- | --- | --- |
| Service worker (`src/background/main.ts`) | MV3 SW | Activated on user interaction | CDP attach/detach, event ingest, scrub, persist to `chrome.storage.session`, broadcast stats |
| Popup (`src/popup/`) | Action popup | Closed when user clicks elsewhere | Start/Stop/Preview/Submit, transcript editor, host filter, audio playback |
| Options page (`src/options/`) | Extension page | Browser tab | POST endpoint, bearer token, retain-audio toggle, host allowlist |
| Offscreen doc (`src/offscreen/recorder.html`) | Hidden DOM doc | Created on Start, destroyed on Stop | Hosts `getUserMedia` + `MediaRecorder` (MV3 SW can't) |
| Content script (`src/content/banner.ts`) | Active tab | Injected on Start | Renders friendly "Recording" banner over Chrome's yellow CDP banner |

The content script does **no** capture — CDP does it all. The script exists
only to soften the alarming-looking Chrome debugger banner with a friendlier
overlay + quick Stop button.

### 1.2 Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Browser process                           │
│                                                                      │
│  ┌───────────┐     ┌──────────────────┐     ┌──────────────┐         │
│  │  Popup    │ <-> │ Service worker   │ <-> │  Offscreen   │         │
│  │ (React)   │     │ (background)     │     │  document    │         │
│  └─────┬─────┘     └────────┬─────────┘     │  (audio)     │         │
│        │                    │                └──────────────┘        │
│        │ chrome.runtime     │ chrome.debugger (CDP)                  │
│        │ .connect (port)    │ chrome.storage.session                 │
│        ▼                    ▼                                        │
│  ┌───────────┐     ┌──────────────────┐                              │
│  │  Options  │     │  Active tab      │  ◀── content script banner   │
│  │   page    │     │  (workflow)      │                              │
│  └───────────┘     └──────────────────┘                              │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ user clicks "Submit"
                  ┌─────────────────────────────┐
                  │  Bundle .json (download)    │ → specialist-agent learn --bundle=...
                  │  or POST to host endpoint   │ → POST /v1/bundles
                  └─────────────────────────────┘
```

### 1.3 Message contracts (`src/shared/messages.ts`)

```ts
type ClientMessage =
  | { type: "POPUP_TO_BG_START_RECORDING";   tabId: number; recordAudio: boolean }
  | { type: "POPUP_TO_BG_STOP_RECORDING" }
  | { type: "POPUP_TO_BG_GET_SNAPSHOT" }
  | { type: "POPUP_TO_BG_UPDATE_INTENT";     intent: string; narrative?: string }
  | { type: "POPUP_TO_BG_FILTER_HOST";       hostPattern: string | null }
  | { type: "POPUP_TO_BG_BUILD_BUNDLE";      includeAudio: boolean }
  | { type: "POPUP_TO_BG_SUBMIT_DOWNLOAD" }
  | { type: "POPUP_TO_BG_SUBMIT_POST" }
  | { type: "POPUP_TO_BG_DISCARD" }
  | { type: "OPTIONS_TO_BG_SET_CONFIG";          config: ExtensionConfig }
  | { type: "OFFSCREEN_TO_BG_AUDIO_CHUNK";       chunk: Blob; mimeType: string }
  | { type: "OFFSCREEN_TO_BG_TRANSCRIPT_PARTIAL"; text: string; isFinal: boolean }
  | { type: "OFFSCREEN_TO_BG_RECORDING_STOPPED"; finalAudio: Blob | null };

type ServerMessage =
  | { type: "BG_TO_POPUP_CAPTURE_STATS";     stats: CaptureStats }
  | { type: "BG_TO_POPUP_BUNDLE_READY";      bundle: BundleSummary }
  | { type: "BG_TO_POPUP_TRANSCRIPT";        intent: string; narrative: string }
  | { type: "BG_TO_POPUP_ERROR";             code: ErrorCode; detail: string }
  | { type: "BG_TO_OFFSCREEN_START_RECORDING"; mimeType: string }
  | { type: "BG_TO_OFFSCREEN_STOP_RECORDING" }
  | { type: "BG_TO_CONTENT_SHOW_BANNER";     state: "recording" | "stopped" };

interface CaptureStats {
  exchangeCount: number;
  totalBytes: number;
  byHost: Record<string, { count: number; bytes: number }>;
  startedAt: string;
  durationMs: number;
}
```

Two channels: long-lived port `POPUP_STATS_PORT` for streaming stats (250ms
cadence), one-shot `chrome.runtime.sendMessage` for commands.

### 1.4 Sequence (single recording)

1. User clicks **Start** → `POPUP_TO_BG_START_RECORDING` (tabId, recordAudio).
2. SW: `chrome.debugger.attach({tabId}, "1.3")`, then `Network.enable`.
3. If audio: `chrome.offscreen.createDocument(...)` + `BG_TO_OFFSCREEN_START_RECORDING`.
4. SW injects content script (`chrome.scripting.executeScript`) → banner.
5. CDP fires events; SW correlates by `requestId`, fetches body on `loadingFinished`.
6. SW scrubs each exchange (port of `src/capture/scrub.ts`), persists to `chrome.storage.session`, pushes stats to popup every 250ms.
7. User clicks **Stop** → CDP detach, offscreen doc closes, banner removed.
8. Offscreen returns final audio + transcript.
9. User edits transcript in popup → `POPUP_TO_BG_UPDATE_INTENT`.
10. User clicks **Download** or **POST** → SW builds bundle, dispatches.

## 2. CDP capture mechanism

### 2.1 Why CDP, not webRequest

`chrome.webRequest` in MV3 cannot read response bodies. `chrome.debugger`
exposes the full DevTools Protocol including `Network.getResponseBody`. Cost:
the yellow "Specialist is debugging this browser" banner. Mitigation in §13.

### 2.2 Subscribed events

After `chrome.debugger.attach({tabId}, "1.3")` and `Network.enable`:

| Event | Use |
| --- | --- |
| `Network.requestWillBeSent` | Create pending exchange; if `redirectResponse` present, finalize previous redirect link first |
| `Network.requestWillBeSentExtraInfo` | Merge raw request headers (cookies that aren't visible to JS) |
| `Network.responseReceived` | Record status, headers, mimeType (body not yet fetchable) |
| `Network.responseReceivedExtraInfo` | Merge raw response headers including `set-cookie` |
| `Network.dataReceived` | Size tracking only — we do not reassemble bodies from these events |
| `Network.loadingFinished` | **Trigger:** call `Network.getResponseBody` here |
| `Network.loadingFailed` | Emit synthetic exchange with `status: 0` and `x-extension-error` header |
| `Network.webSocketCreated`/`Frame*` | **v1: skipped.** Note in popup that WS frames aren't captured |

We do **not** subscribe to `Page`, `Runtime`, `DOM`, or `Fetch`.

### 2.3 Reconstruction state machine (`src/background/cdp/reconstruct.ts`)

```ts
interface PendingExchange {
  requestId: string;
  startedAt: string;
  request: Partial<HttpExchange["request"]>;
  response?: Partial<HttpExchange["response"]>;
  bytesReceived: number;
  finalized: boolean;
}

const pending = new Map<string, PendingExchange>();
const completed: HttpExchange[] = [];
```

Algorithm:

1. `requestWillBeSent`: if `redirectResponse`, locate pending entry by `requestId`, finalize it (response = redirectResponse), push to `completed`, then create a new pending entry under the same `requestId` for the redirect target. CDP reuses requestId across redirects.
2. `*ExtraInfo`: merge headers; tolerate either order (50ms race window — buffer extra-info if pending entry doesn't exist yet).
3. `responseReceived`: fill status, headers, mimeType.
4. `loadingFinished`: `chrome.debugger.sendCommand({tabId}, "Network.getResponseBody", {requestId})` → `{body, base64Encoded}`.
5. Apply scrub → push to `completed` → delete from `pending`.
6. `loadingFailed`: emit synthetic failed exchange.

### 2.4 Body handling

| Body type | Handling |
| --- | --- |
| JSON (`mimeType.includes("application/json")`) | `JSON.parse(body)`; on failure, retain string. Mirrors `parseHarContent` at `src/capture/har.ts:81`. |
| Text (`text/*`, form-encoded) | Raw string |
| Binary | If `base64Encoded`, store `{__binary: true, mediaType, length}` — do NOT retain payload |
| > 1 MiB (configurable) | Truncate, append `_truncated: true` marker |
| SSE (`text/event-stream`) | Raw text up to size cap; document SSE-as-single-response synthesis behavior |

### 2.5 Edge cases

| Case | Behavior |
| --- | --- |
| CORS preflight (`OPTIONS`) | Captured |
| Sub-frame requests | Captured (filter to top-frame as v1.1 option) |
| Service-worker-fetched | Captured (CDP sees them at network layer) |
| Tab navigates mid-capture | CDP attach survives; emit synthetic `{method:"NAVIGATE", url}` boundary |
| Tab closes mid-capture | `chrome.debugger.onDetach` reason `target_closed`; finalize session, error toast |
| Multiple tabs | v1: single-tab. Popup grays Start if active recording elsewhere |
| User opens DevTools mid-capture | CDP attach refused; surface "DevTools is open — close it to capture" |

### 2.6 Adapter interface (`src/background/cdp/adapter.ts`)

```ts
export interface CaptureAdapter {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  onExchange(cb: (e: HttpExchange) => void): void;
  onError(cb: (e: { code: string; detail: string }) => void): void;
}

export class ChromeDebuggerAdapter implements CaptureAdapter { /* CDP wiring */ }
export class FirefoxFilterResponseDataAdapter implements CaptureAdapter { /* webRequest wiring */ }
```

## 3. Firefox parity (v1.1)

Firefox MV3 supports `webRequest.filterResponseData` (Firefox-only stream
filter that observes response bodies). With `onBeforeRequest`,
`onSendHeaders`, `onHeadersReceived`, and `filterResponseData` we rebuild the
same `HttpExchange` shape with no debugger banner.

Tradeoffs vs CDP:

- No yellow banner — better UX.
- Slightly different body handling (raw bytes; mime-sniff).
- No `loadingFinished.encodedDataLength` timing.

Audio path on Firefox: no `chrome.offscreen`. v1.1 uses
`tabs.create({active: false, pinned: true})` opening a hidden `recorder.html`
that hosts `MediaRecorder`. Less elegant; document.

## 4. Voice narration

### 4.1 Engine choice

| Engine | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| Web Speech API | Free, zero bundle, real-time partials | Chrome-only; sends audio to Google | **Default for Chrome** |
| Whisper.wasm (~30 MB) | Offline, private, Firefox-capable | Bundle size; no live partials | Fallback for Firefox + offline opt-in |
| Backend transcription | Highest quality | Backend dep, contradicts "no auto-submit" | Not v1 |
| Anthropic Files + Claude | Possible | Not optimized for transcription | Not v1 |

Privacy note shown in popup: "Voice transcription uses Chrome's built-in
speech recognition, which may send audio to Google. Enable Whisper in options
to transcribe offline."

### 4.2 When transcription happens

- **Chrome (Web Speech):** live during recording. `onresult` emits interim + final → `OFFSCREEN_TO_BG_TRANSCRIPT_PARTIAL` → SW updates session intent → popup re-renders.
- **Firefox (Whisper):** on Stop. Show "Transcribing..." spinner (~10s for 30s clip).

### 4.3 Audio capture in MV3

`getUserMedia`/`MediaRecorder` are unavailable in service workers. Use an
**offscreen document**:

```ts
await chrome.offscreen.createDocument({
  url: "offscreen/recorder.html",
  reasons: ["USER_MEDIA"],
  justification: "Record voice narration of the workflow being captured"
});
```

The offscreen doc:

1. `getUserMedia({audio: true})`.
2. `MediaRecorder({mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000})` — opus 32kbps ≈ 120 KB / 30s.
3. Same stream → `SpeechRecognition` (Chrome) or PCM buffer for Whisper (Firefox).
4. `MediaRecorder.ondataavailable` (timeslice 1000ms) → post chunk to SW.
5. On stop, post final concatenated Blob.

Persists across popup-close events because it's a separate document. SW closes
via `chrome.offscreen.closeDocument()` after Stop completes.

### 4.4 Transcript editing

Popup renders two textareas:

- `intent` (one-line, defaults to first sentence of transcript).
- `narrative` (full transcript, multi-line, collapsible).

Edits → debounced 300ms → `POPUP_TO_BG_UPDATE_INTENT` → SW persists to
`chrome.storage.session`. Bundle reads verbatim at build.

### 4.5 Audio retention

Default: discarded after transcription. Per-recording toggle in popup. When
on, bundle's `audio` field is the base64 webm Blob. Synthesis ignores it; it
exists for the user to re-listen.

### 4.6 Recorder interface (`src/offscreen/recorder.ts`)

```ts
export interface RecorderOptions {
  mimeType: string;
  audioBitsPerSecond: number;
  transcriber: "webspeech" | "whisper-wasm";
}

export class VoiceRecorder {
  start(opts: RecorderOptions): Promise<void>;
  stop(): Promise<{ audio: Blob; transcript: string }>;
  onPartial(cb: (text: string, isFinal: boolean) => void): void;
}
```

## 5. Auth scrubbing

### 5.1 Recommendation: duplicate-with-fixture-test

Avoid monorepo conversion. Duplicate `src/capture/scrub.ts` to
`browser-extension/src/capture/scrub.ts` byte-for-byte. Add a fixture file
used by **both** sides:

```
test/fixtures/scrub-cases.json    (NEW — shared between host + extension)
```

Schema:

```jsonc
{
  "cases": [
    {
      "name": "authorization header lowercased",
      "input":  { "headers": { "Authorization": "Bearer sk_live_abc123" } },
      "expected": { "headers": { "Authorization": "{{auth}}" } }
    },
    {
      "name": "bearer token in form-encoded body",
      "input":  { "body": "grant_type=refresh&refresh_token=abc Bearer eyJhbG..." },
      "expected": { "body": "grant_type=refresh&refresh_token=abc Bearer {{auth}}" }
    },
    {
      "name": "nested client_secret in JSON body",
      "input":  { "body": { "auth": { "client_secret": "shh" } } },
      "expected": { "body": { "auth": { "client_secret": "{{auth}}" } } }
    }
    // ~30 cases covering every branch of scrub.ts
  ]
}
```

Two test runners:

| Runner | Path | Asserts |
| --- | --- | --- |
| Node (Vitest) | `test/scrub-fixture.test.ts` (NEW) | Host scrub vs fixture |
| Browser (Vitest, jsdom) | `browser-extension/test/scrub.test.ts` | Browser port vs same fixture |

CI runs both; if either drifts, the build fails.

### 5.2 When scrubbing happens

Pattern from `src/capture/buffer.ts:29-43` — scrub on `add()`, BEFORE the
exchange is appended. SW does the same: scrub immediately after
`Network.getResponseBody` resolves, BEFORE writing to
`chrome.storage.session`.

Defense-in-depth: re-apply on bundle build path.

### 5.3 Files to port

| Source | Destination | Changes |
| --- | --- | --- |
| `src/capture/scrub.ts` | `browser-extension/src/capture/scrub.ts` | Identical — pure functions, no Node imports |
| `src/types.ts` (`HttpTrace`, `HttpExchange`) | `browser-extension/src/shared/types.ts` | Identical |
| `src/capture/buffer.ts` | `browser-extension/src/capture/buffer.ts` | Replace `randomUUID` from `node:crypto` with `crypto.randomUUID()` (browser native) |

## 6. Bundle output

### 6.1 Schema (`browser-extension/src/bundle/schema.ts`, mirrored on host at `src/bundle/schema.ts`)

```ts
export const BundleSchema = z.object({
  schemaVersion: z.literal("1"),
  intent: z.string().min(1).max(2000),
  narrative: z.string().max(50_000).optional(),
  har: z.object({
    log: z.object({
      version: z.literal("1.2"),
      creator: z.object({ name: z.string(), version: z.string() }),
      browser: z.object({ name: z.string(), version: z.string() }).optional(),
      pages: z.array(z.unknown()).optional(),
      entries: z.array(HarEntrySchema)
    })
  }),
  audio: z.object({
    mimeType: z.string(),       // "audio/webm;codecs=opus"
    base64: z.string(),
    durationMs: z.number()
  }).nullable(),
  metadata: z.object({
    capturedBy: z.literal("specialist-extension"),
    extensionVersion: z.string(),
    browser: z.string(),        // "chrome/120"
    capturedAt: z.string(),     // ISO 8601
    tabUrl: z.string().optional()
  })
});

export type Bundle = z.infer<typeof BundleSchema>;
```

### 6.2 HAR 1.2 fields emitted

Strict subset of what `src/capture/har.ts:43-61` reads:

```jsonc
{
  "log": {
    "version": "1.2",
    "creator": { "name": "specialist-extension", "version": "0.1.0" },
    "entries": [
      {
        "startedDateTime": "2026-05-02T15:30:11.123Z",
        "time": 142,
        "request": {
          "method": "POST",
          "url": "https://api.stripe.com/v1/customers",
          "headers": [
            { "name": "Authorization", "value": "{{auth}}" },
            { "name": "Content-Type", "value": "application/x-www-form-urlencoded" }
          ],
          "postData": {
            "mimeType": "application/x-www-form-urlencoded",
            "text": "email=alice%40example.com&name=Alice"
          }
        },
        "response": {
          "status": 200,
          "headers": [{ "name": "Content-Type", "value": "application/json" }],
          "content": {
            "mimeType": "application/json",
            "text": "{\"id\":\"cus_abc\",\"email\":\"alice@example.com\"}"
          }
        }
      }
    ]
  }
}
```

Binary bodies: emit `text` as `"{\"__binary\":true,\"length\":4096}"` so
`content.text` remains a string the existing parser handles.

### 6.3 Filename + MIME

`specialist-bundle-<iso8601>-<short-id>.json`

- `iso8601`: `YYYYMMDDTHHMMSSZ` (no colons, OS-safe).
- `short-id`: 6-char base32 truncation of `crypto.randomUUID()`.

Example: `specialist-bundle-20260502T153011Z-a3b9k2.json`. MIME
`application/json`, dispatched via `chrome.downloads.download` with
`saveAs: true`.

### 6.4 Worked example: 3-request Stripe enterprise-onboarding bundle

```jsonc
{
  "schemaVersion": "1",
  "intent": "Onboard a new enterprise customer with first invoice",
  "narrative": "OK so I'm creating the customer first — for enterprise we always set collection_method to send_invoice. Then I'm creating an invoice item, then finalizing the invoice. The 30-day terms are the default for these accounts.",
  "har": {
    "log": {
      "version": "1.2",
      "creator": { "name": "specialist-extension", "version": "0.1.0" },
      "entries": [
        {
          "startedDateTime": "2026-05-02T15:30:11.123Z",
          "time": 142,
          "request": {
            "method": "POST",
            "url": "https://api.stripe.com/v1/customers",
            "headers": [
              { "name": "Authorization", "value": "{{auth}}" },
              { "name": "Content-Type", "value": "application/x-www-form-urlencoded" }
            ],
            "postData": {
              "mimeType": "application/x-www-form-urlencoded",
              "text": "email=alice%40acme.com&name=Acme+Inc"
            }
          },
          "response": {
            "status": 200,
            "headers": [{ "name": "Content-Type", "value": "application/json" }],
            "content": {
              "mimeType": "application/json",
              "text": "{\"id\":\"cus_NffrFeUfNV2Hib\",\"email\":\"alice@acme.com\"}"
            }
          }
        },
        {
          "startedDateTime": "2026-05-02T15:30:11.402Z",
          "time": 98,
          "request": {
            "method": "POST",
            "url": "https://api.stripe.com/v1/invoiceitems",
            "headers": [
              { "name": "Authorization", "value": "{{auth}}" },
              { "name": "Content-Type", "value": "application/x-www-form-urlencoded" }
            ],
            "postData": {
              "mimeType": "application/x-www-form-urlencoded",
              "text": "customer=cus_NffrFeUfNV2Hib&amount=5000&currency=usd&description=Setup+fee"
            }
          },
          "response": {
            "status": 200,
            "headers": [{ "name": "Content-Type", "value": "application/json" }],
            "content": {
              "mimeType": "application/json",
              "text": "{\"id\":\"ii_1NXxYZ\",\"customer\":\"cus_NffrFeUfNV2Hib\",\"amount\":5000}"
            }
          }
        },
        {
          "startedDateTime": "2026-05-02T15:30:11.621Z",
          "time": 188,
          "request": {
            "method": "POST",
            "url": "https://api.stripe.com/v1/invoices",
            "headers": [
              { "name": "Authorization", "value": "{{auth}}" },
              { "name": "Content-Type", "value": "application/x-www-form-urlencoded" }
            ],
            "postData": {
              "mimeType": "application/x-www-form-urlencoded",
              "text": "customer=cus_NffrFeUfNV2Hib&collection_method=send_invoice&days_until_due=30"
            }
          },
          "response": {
            "status": 200,
            "headers": [{ "name": "Content-Type", "value": "application/json" }],
            "content": {
              "mimeType": "application/json",
              "text": "{\"id\":\"in_1NXxYZ\",\"status\":\"draft\",\"collection_method\":\"send_invoice\",\"days_until_due\":30}"
            }
          }
        }
      ]
    }
  },
  "audio": null,
  "metadata": {
    "capturedBy": "specialist-extension",
    "extensionVersion": "0.1.0",
    "browser": "chrome/120",
    "capturedAt": "2026-05-02T15:30:11.000Z",
    "tabUrl": "https://dashboard.stripe.com/test/customers"
  }
}
```

## 7. Submission paths

### 7.1 Download (default v1)

`chrome.downloads.download({url: blobUrl, filename, saveAs: true})`. User
feeds the file to:

```bash
specialist-agent learn --tenant=tenants/acme --bundle=~/Downloads/specialist-bundle-...json
```

### 7.2 POST (opt-in)

User configures in options page; stored in `chrome.storage.sync`.

```ts
interface ExtensionConfig {
  postEndpoint: string | null;       // e.g. "https://specialist.acme.internal"
  postBearerToken: string | null;
  retainAudioByDefault: boolean;
  bodyMaxBytes: number;              // default 1_048_576
  hostFilterMode: "all" | "allowlist";
  hostAllowlist: string[];
}
```

Request:

```http
POST {postEndpoint}/v1/bundles
Content-Type: application/json
Authorization: Bearer {postBearerToken}     (omitted if null)

<bundle JSON>
```

Responses:

```jsonc
// 200
{ "accepted": true, "traceId": "trace_...", "learnUrl": "..." }

// 400 invalid bundle
{ "error": "invalid_bundle", "detail": "schemaVersion '2' is not supported" }

// 401
{ "error": "unauthorized", "detail": "missing or invalid bearer token" }

// 413
{ "error": "bundle_too_large", "detail": "bundle exceeds 50 MiB limit" }

// 500
{ "error": "synthesis_failed", "detail": "..." }
```

The server endpoint is **out of scope** for this plan, but its contract is:

1. Validate against `BundleSchema`.
2. Write `har` to a temp file.
3. `importHar(tmpPath, bundle.intent)` → `HttpTrace`.
4. Resolve tenant from auth (server's responsibility).
5. `agent.learnFromTrace(trace, { skipReplay: false })` (`src/agent.ts:200`).
6. Return `traceId` + optional `learnUrl`.

POST failure → popup error toast with `error` + `detail`, "Download instead"
fallback button. Bundle stays in session storage until user discards.

## 8. CLI integration

### 8.1 New `--bundle` flag

`src/cli/main.ts:19` — add to `Flags`:

```ts
interface Flags {
  // existing...
  bundle?: string;
}
```

`src/cli/main.ts:45` — `cmdLearn`:

```ts
async function cmdLearn(flags: Flags): Promise<void> {
  if (!flags.tenant) die("missing --tenant=<path>");
  if (flags.bundle && flags.har) die("--bundle and --har are mutually exclusive");

  let trace: HttpTrace;
  if (flags.bundle) {
    const bundleRaw = await fs.readFile(flags.bundle, "utf8");
    const bundle = BundleSchema.parse(JSON.parse(bundleRaw));
    if (flags.intent && flags.intent !== bundle.intent) {
      die("--intent collides with bundle.intent; remove --intent or omit --bundle");
    }
    const tmp = path.join(os.tmpdir(), `specialist-bundle-${Date.now()}.har`);
    await fs.writeFile(tmp, JSON.stringify(bundle.har));
    try {
      trace = await importHar(tmp, bundle.intent);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    if (bundle.narrative) {
      trace.intent = `${bundle.intent}\n\n[narration: ${bundle.narrative}]`;
    }
  } else if (flags.har) {
    if (!flags.intent) die("missing --intent=\"...\"");
    trace = await importHar(flags.har, flags.intent);
  } else {
    die("missing --bundle=<file> or --har=<file>");
  }
  // ...rest unchanged: build agent, learnFromTrace, log result
}
```

`src/cli/main.ts:155` — help text:

```
  learn --tenant=<path> (--bundle=<file> | --har=<file> --intent="...") [--auto-keep]
```

### 8.2 Schema location

Mirror `BundleSchema` at `src/bundle/schema.ts` (NEW host-side). Extension
imports its own copy. Lockstep enforced via shared fixture
`test/fixtures/bundle-example.json` validated by both sides.

## 9. Project layout

```
browser-extension/
  package.json
  vite.config.ts
  manifest.config.ts
  tsconfig.json
  src/
    background/
      main.ts                # SW entry
      router.ts              # message dispatch
      session.ts             # capture session lifecycle
      cdp/
        adapter.ts           # CaptureAdapter interface
        chrome-debugger.ts   # CDP impl
        firefox-filter.ts    # webRequest impl (v1.1)
        events.ts            # CDP event types
        reconstruct.ts       # pending-exchange state machine
      storage.ts             # chrome.storage.session checkpointing
      offscreen-control.ts
    offscreen/
      recorder.html
      recorder.ts
      transcribe-webspeech.ts
      transcribe-whisper.ts  # lazy-loaded
    popup/
      index.html
      popup.tsx              # React entry
      App.tsx
      components/
        StartStop.tsx
        StatsPanel.tsx
        HostFilter.tsx
        TranscriptEditor.tsx
        AudioPlayback.tsx
        SubmitMenu.tsx
      hooks/
        useStatsPort.ts
        useSession.ts
    options/
      index.html
      options.tsx
      Form.tsx
    content/
      banner.ts
      banner.css
    capture/
      scrub.ts               # PORT of src/capture/scrub.ts
      buffer.ts              # PORT
      har-emit.ts            # HttpExchange[] -> HAR 1.2
    bundle/
      schema.ts              # zod
      build.ts
      submit-download.ts
      submit-post.ts
    shared/
      types.ts               # mirrors src/types.ts
      messages.ts            # ClientMessage/ServerMessage
      config.ts
      logger.ts
  test/
    scrub.test.ts
    har-emit.test.ts
    bundle-build.test.ts
    cdp-reconstruct.test.ts
    fixtures/
      cdp-stripe-customer.jsonl   # recorded CDP events for replay
  vendor/
    whisper-tiny.wasm        # lazy-loaded; only when D1 includes Whisper
    whisper.js
  README.md
  CHANGELOG.md
```

## 10. Permissions manifest

### 10.1 Chrome `manifest.json`

```jsonc
{
  "manifest_version": 3,
  "name": "Specialist Capture",
  "version": "0.1.0",
  "description": "Capture HTTP workflows for the specialist-agent.",
  "background": {
    "service_worker": "src/background/main.ts",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/index.html",
    "default_title": "Specialist Capture"
  },
  "options_page": "src/options/index.html",
  "permissions": [
    "debugger",     // CDP — only MV3-supported response-body path
    "storage",      // session captures + sync settings
    "downloads",    // save bundle JSON
    "scripting",    // inject recording banner
    "offscreen",    // host MediaRecorder
    "tabs"          // identify active tabId
  ],
  "host_permissions": ["<all_urls>"],
  "web_accessible_resources": [
    { "resources": ["vendor/whisper-tiny.wasm", "vendor/whisper.js"], "matches": ["<all_urls>"] }
  ]
}
```

### 10.2 Firefox additions (v1.1)

```jsonc
{
  "browser_specific_settings": {
    "gecko": { "id": "specialist@anthropic.invalid", "strict_min_version": "115.0" }
  },
  "permissions": [
    "webRequest", "webRequestBlocking", "webRequestFilterResponseData",
    "storage", "downloads", "scripting", "tabs"
  ]
}
```

### 10.3 Justifications (one line each, store-review)

| Permission | Justification |
| --- | --- |
| `debugger` | Read response bodies via CDP — only MV3 path on Chrome |
| `storage` | Session-scoped captures + sync user settings |
| `downloads` | Save bundle JSON to disk |
| `scripting` | Inject "recording in progress" banner |
| `offscreen` | Host `MediaRecorder` for voice (SW can't) |
| `tabs` | Active-tab id for capture attach |
| `<all_urls>` | CDP cannot be scoped per-host; user-driven filter trims what's stored |

## 11. Testing plan

### 11.1 Unit (Vitest)

| Test | Path | Asserts |
| --- | --- | --- |
| `scrub.test.ts` | `browser-extension/test/scrub.test.ts` | Browser scrub vs `test/fixtures/scrub-cases.json` |
| `scrub-fixture.test.ts` | `test/scrub-fixture.test.ts` (NEW host) | Host scrub vs same fixture |
| `cdp-reconstruct.test.ts` | `browser-extension/test/cdp-reconstruct.test.ts` | Replays `fixtures/cdp-stripe-customer.jsonl` → expected `HttpExchange[]` |
| `har-emit.test.ts` | `browser-extension/test/har-emit.test.ts` | `HttpExchange[]` → emitted HAR → `importHar` → byte-equal `HttpTrace` (modulo `id` UUID + ISO timestamps) |
| `bundle-build.test.ts` | `browser-extension/test/bundle-build.test.ts` | Bundle assembly + `BundleSchema.parse` |

### 11.2 Integration (Playwright)

`browser-extension/test/integration/record.spec.ts`:

1. Launch Chromium with the unpacked extension via `launchPersistentContext({ args: ["--load-extension=..."] })`.
2. Stand up a fake Express server with a known route sequence.
3. Click action, click Start, drive the page through the workflow.
4. Click Stop, click Download.
5. Read downloaded bundle from temp dir, parse, assert HAR round-trips through `importHar` to `HttpTrace`, byte-equal to `test/fixtures/expected-trace.json` (modulo `id` UUID + timestamps).

Mock `MediaRecorder` and `SpeechRecognition` via Playwright's
`page.addInitScript` to emit a deterministic transcript ("test narration
here") for stable CI.

### 11.3 End-to-end (`@stripe-sandbox`, CI-optional)

`browser-extension/test/e2e/stripe-parity.spec.ts`:

1. Read `STRIPE_TEST_KEY`; skip if absent.
2. Run extension capture against `dashboard.stripe.com/test`.
3. `specialist-agent learn --bundle=<downloaded>.json --tenant=tenants/test`.
4. Independently run `learn --har=examples/stripe-trace.har --tenant=tenants/test-har --intent="..."`.
5. Diff resulting `services/stripe.ts`; assert byte-equality modulo timestamps.

### 11.4 Voice tests

- `voice.unit.test.ts`: stub `MediaRecorder` + `SpeechRecognition`, assert transcript flows offscreen → SW → popup.
- `voice.integration.test.ts`: pipe `test/fixtures/narration-30s.wav` through mock `getUserMedia`; assert non-empty transcript.

## 12. Installation + migration

### 12.1 v1 distribution

- **Chrome:** unpacked. `chrome://extensions` → Developer Mode → "Load unpacked" pointing at `browser-extension/dist`. Web Store publish in v1.1.
- **Firefox (v1.1):** `about:debugging` → "Load Temporary Add-on" → `manifest.json`. AMO publish in v1.2.

### 12.2 User journey

1. `npm install -g specialist-agent` (synthesis runtime, still required).
2. Clone or download extension release zip; unpack.
3. Load extension in Chrome.
4. Open options page; paste POST endpoint + bearer token (or leave blank for download-only).
5. Open the SaaS app to teach (e.g. `dashboard.stripe.com`).
6. Click extension icon → Start. Chrome shows yellow CDP banner; extension overlays a friendlier "Recording — click to stop".
7. Perform workflow. Optionally narrate aloud.
8. Click Stop. Popup shows request count, bytes, host breakdown. Transcript appears in editable textarea.
9. Edit intent + narrative; toggle "Include audio" if desired.
10. Click "Download bundle" → `specialist-agent learn --bundle=~/Downloads/...json --tenant=tenants/acme`. Or click "Submit to host" → POST → `traceId` + optional `learnUrl`.

### 12.3 Coexistence with npm package

Extension produces bundles. npm package consumes them. Decoupled releases. A
user with only the npm package still captures via DevTools HAR + `--har=`. A
user with only the extension cannot synthesize — bundles are for someone else
(teammate, CI job) to consume.

## 13. Risks and effort

### 13.1 Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Yellow CDP debugger banner alarms users | High | Friendly overlay banner + Stop button; docs page from popup; honest install copy |
| Whisper.wasm ~30 MB | Medium | Lazy-load on first record; Chrome path skips entirely (Web Speech); cache in IndexedDB |
| Firefox parity | Medium | Ship Chrome v1; `CaptureAdapter` interface keeps Firefox swappable; v1.1 dedicated |
| `<all_urls>` host permission | Medium | Web Store reviewers scrutinize — submit with detailed justification + docs link explaining CDP requirement and host filter |
| Single-tab limitation | Low | Document; v1.1 multi-tab merge |
| Web Speech sends audio to Google | Medium | Disclose in popup + options; Whisper opt-in |
| 1 MiB body cap | Low | Configurable; truncation marker preserved |
| Service-worker eviction mid-capture | Medium | Checkpoint to `chrome.storage.session` every 5 exchanges; rehydrate on SW wake; test under forced eviction |
| POST endpoint not implemented host-side | Medium | v1 ships with download default, POST opt-in; document host endpoint as future work item |
| Scrub drift between host + extension | High | Shared fixture file + CI failures on drift |

### 13.2 Effort estimate (eng-weeks, single engineer)

| Component | Estimate |
| --- | --- |
| Project skeleton (Vite, manifest, build, install docs) | 0.5 |
| CDP capture + reconstruct + edge cases | 2.0 |
| Scrub port + shared fixture + dual tests | 0.5 |
| HAR emit + bundle build + zod schema | 0.5 |
| Voice (offscreen + Web Speech + transcript flow) | 1.5 |
| Whisper.wasm fallback (lazy-load + glue) | 1.0 (optional / D1) |
| Popup UI (React + components) | 1.5 |
| Options page | 0.5 |
| Content script banner | 0.25 |
| Submission paths (download + POST) | 0.5 |
| Unit + integration tests | 1.0 |
| E2E + Stripe parity (CI-optional) | 1.0 |
| CLI `--bundle` flag + host-side schema | 0.5 |
| Firefox parity (v1.1) | 2.0 |
| **v1 (Chrome only, Web Speech)** | **~9.5 weeks** |
| **v1.1 (+ Firefox + Whisper)** | **~12.5 weeks** |

Two engineers can roughly halve v1 — popup and capture are independent.

## 14. File-path reference

| Need | File |
| --- | --- |
| `HttpTrace` shape | `src/types.ts:6` |
| Scrub source | `src/capture/scrub.ts` |
| HAR import | `src/capture/har.ts:12` |
| Buffer + scrub-on-add | `src/capture/buffer.ts:22` |
| Fetch interceptor (parity ref) | `src/capture/interceptor.ts:12` |
| `learnFromTrace` consumer | `src/agent.ts:200` |
| CLI flags | `src/cli/main.ts:19` |
| CLI `learn` handler | `src/cli/main.ts:45` |
| CLI help text | `src/cli/main.ts:155` |
| Existing capture surfaces doc | `docs/CAPTURE.md` |
| Original prompt | `prompts/plan-browser-extension.md` |
