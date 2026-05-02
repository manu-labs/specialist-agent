# Specialist Capture (browser extension)

Chrome MV3 extension that captures HTTP workflows for `specialist-agent`. Records the network conversation via the Chrome DevTools Protocol, lets the user describe the workflow (typed or voice-narrated), and emits a single bundle file that the host CLI consumes via `--bundle=...`.

This is the third capture surface alongside DevTools-HAR and the in-process fetch interceptor — see [`docs/CAPTURE.md`](../docs/CAPTURE.md). The original architecture plan lives at [`prompts/PLANS/browser-extension.md`](../prompts/PLANS/browser-extension.md).

## Status

- **v1 (this release):** Chrome only, Web Speech transcription, download or POST submission paths, no auto-merge of multi-tab captures.
- **v1.1 (planned):** Firefox via `webRequest.filterResponseData`, Whisper.wasm offline transcription, multi-tab merge.

## Build

```bash
cd browser-extension
npm install
npm run build      # produces dist/
npm run typecheck
npm run test       # vitest — runs scrub fixture, CDP reconstruct, HAR emit, bundle build
```

## Install (Chrome, unpacked)

1. `npm run build` from this directory.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. **Load unpacked** → select the `browser-extension/dist` directory.
5. Pin the action so the popup is one click away.

## Use

1. Open the SaaS app you want to teach (e.g. `dashboard.stripe.com`).
2. Click the extension icon → **Start** (optionally tick "narrate aloud").
3. Chrome shows a yellow CDP banner; the extension overlays a friendlier "Recording" banner with a **Stop** button.
4. Drive the workflow. Optionally narrate aloud — the transcript fills in live (Chrome only; Web Speech sends audio to Google).
5. Click **Stop**. The popup shows request count, total bytes, and a per-host breakdown.
6. Edit the **intent** field and (optional) **narration** — these become the bundle's `intent` and `narrative`.
7. Click **Download bundle** to save the `.json` to disk, or **Submit to host** to POST to your configured synthesis endpoint.

Then, on a machine with `specialist-agent` installed:

```bash
specialist-agent learn \
  --tenant=tenants/acme \
  --bundle=~/Downloads/specialist-bundle-20260502T153011Z-a3b9k2.json
```

`--bundle` and `--har` are mutually exclusive. The intent + narrative come from the bundle, so don't pass `--intent` with `--bundle`.

## Permissions

| Permission | Why |
| --- | --- |
| `debugger` | Read response bodies via the DevTools Protocol — only path on Chrome MV3 |
| `storage` | Session captures + sync user settings (POST endpoint, allowlist, etc.) |
| `downloads` | Save bundle JSON to disk |
| `scripting` | Inject the friendly recording banner into the active tab |
| `offscreen` | Host MediaRecorder for voice narration (service workers can't) |
| `tabs` | Identify the active tab to attach the debugger |
| `<all_urls>` | The DevTools Protocol cannot be scoped per-host. The user-driven host filter trims what is stored. |

## Bundle format

Defined by `src/bundle/schema.ts` and mirrored at `../src/bundle/schema.ts` on the host. Both copies parse the same shared fixture (`../test/fixtures/bundle-example.json`) in CI.

```jsonc
{
  "schemaVersion": "1",
  "intent": "Onboard a new enterprise customer with first invoice",
  "narrative": "...optional voice narration...",
  "har": { "log": { "version": "1.2", "creator": {...}, "entries": [...] } },
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

Filename convention: `specialist-bundle-<iso8601>-<short-id>.json`.

## Scrubbing

`src/capture/scrub.ts` is a byte-for-byte port of `../src/capture/scrub.ts`. The shared fixture in `../test/fixtures/scrub-cases.json` runs against both copies in CI; if either drifts, the build fails. Scrubbing happens twice as defense-in-depth: once on each exchange as it leaves CDP, and again on bundle build.

## POST endpoint contract

When the user clicks "Submit to host", the extension POSTs the bundle JSON to:

```
POST {postEndpoint}/v1/bundles
Content-Type: application/json
Authorization: Bearer {postBearerToken}     (omitted if blank)
```

Server contract is documented in [`prompts/PLANS/browser-extension.md`](../prompts/PLANS/browser-extension.md) §7.2; the endpoint itself is out of scope for the extension. Errors surface as a popup error toast with a "Download instead" fallback.

## Layout

```
browser-extension/
  manifest.config.ts         # @crxjs manifest builder
  vite.config.ts             # Vite + @crxjs + Vitest config
  src/
    background/              # Service worker: CDP attach, ingestion, scrub, persist
      cdp/                   # CaptureAdapter interface + Chrome impl + reconstruct state machine
    offscreen/               # Hidden DOM doc that hosts MediaRecorder + transcriber
    popup/                   # React popup
    options/                 # React options page
    content/                 # Friendly recording banner overlay
    capture/                 # scrub.ts (port), buffer.ts (port), har-emit.ts
    bundle/                  # schema.ts (zod), build.ts, submit-download.ts, submit-post.ts
    shared/                  # types, messages, config, logger
  test/                      # Vitest unit tests + fixtures
  vendor/                    # Whisper-tiny lazy-load slot (gitignored)
```
