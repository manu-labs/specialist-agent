# Plan a browser extension for the specialist-agent capture surface

## How to use this prompt

Hand this file to a planning agent (e.g. Claude Code's `Plan` subagent type, or any LLM-driven planner). The agent should produce a plan file at `prompts/PLANS/browser-extension.md` detailed enough that a follow-up implementation agent can execute it without needing to ask further questions.

This is a **planning task only.** Do not implement the extension.

---

## Context

You're designing the browser-extension capture surface for `specialist-agent` — a Claude Agent SDK app that learns customer workflows from observed HTTP traces and replays them as skills. The architecture lists three capture surfaces. Two ship today:

- **`importHar()`** — DevTools HAR exports, MITM-proxy HAR exports.
- **`attachFetchInterceptor()`** — patches `globalThis.fetch` for the embedded SDK path.

The browser extension is the missing third surface, and the most user-friendly. Rather than asking a customer to fiddle with DevTools or a proxy, they install an extension, click "Start," perform the workflow, click "Stop," and the trace flows into synthesis automatically.

There's also a feature *beyond* parity with the existing surfaces: **voice narration**. Today the user types a one-sentence `--intent="..."` string. With voice, they narrate while doing the workflow ("now I'm creating the customer; I always set collection_method to send_invoice for enterprise accounts because they pay by wire…"). The transcript becomes a much richer intent for synthesis — capturing constraints, defaults, and rationale that a one-liner can't.

## Read first

Spend ~15 minutes reading these files before planning. They define the data shapes, scrubbing logic, and consumer the extension must integrate with.

| File                          | What it tells you                                                            |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `README.md`                   | Project overview, layout, scripts                                            |
| `docs/USAGE.md`               | End-to-end pipeline: capture → synthesize → run                              |
| `docs/CAPTURE.md`             | The two existing capture surfaces; the extension is the third                |
| `docs/EMBEDDING.md`           | Programmatic API, including the trace-submission entry point                 |
| `src/types.ts`                | `HttpTrace`, `HttpExchange` — the shapes the extension must produce          |
| `src/capture/har.ts`          | `importHar()` — what HAR fields the parser uses (your output must round-trip)|
| `src/capture/scrub.ts`        | `scrubHeaders` / `scrubBody` — auth scrubbing the extension must perform too |
| `src/capture/interceptor.ts`  | The Node fetch interceptor — your behavior should match it                   |
| `src/agent.ts:learnFromTrace` | The downstream consumer of whatever the extension produces                   |

## Goals

1. **Network capture** of every request/response on the active tab during a recording session, including request and response bodies (not just headers).
2. **Auth scrubbing in the browser** before any data leaves the user's machine. Mirror `src/capture/scrub.ts` exactly — header allowlist, JSON-key heuristics, `Bearer` patterns in string bodies.
3. **Voice recording** via `navigator.mediaDevices.getUserMedia`, with transcription producing the `intent` string (and optionally a richer `narrative` field that synthesis can consume).
4. **Lightweight UI**: a popup with Start / Stop / Preview / Submit. The preview lets the user (a) see captured request count and bytes, (b) filter to one API host, (c) hear the recording back, (d) edit the transcript before submitting.
5. **Submission paths.** Two options:
   - **Download.** Bundles trace + audio + transcript as a JSON file the user feeds to `specialist-agent learn --har=...` (or a new bundle-aware flag).
   - **POST.** Direct HTTP POST to a user-configured backend endpoint that hosts the `specialist-agent` runtime.

   Plan both. Default to download for v1 (no backend dependency).
6. **Privacy by default.** Captured data lives in extension memory or `chrome.storage.session`; cleared on browser close unless explicitly downloaded. No telemetry. No automatic submission.

## Constraints

- **Manifest V3.** Service-worker-backed background script. Cross-browser via WebExtension APIs (Chrome + Firefox; Safari is a stretch goal).
- **Capture mechanism: `chrome.debugger` API, not `chrome.webRequest`.** Response bodies are not available via `webRequest` in MV3 — `chrome.debugger` (Chrome DevTools Protocol) is the only path. Plan for the visible "DevTools is debugging this tab" banner UX cost. Firefox alternative: `browser.devtools.network` or the legacy `webRequest.filterResponseData` API.
- **Output shape.** The trace portion of the bundle must validate as HAR 1.2 (so `importHar` parses it) OR be the native `HttpTrace` JSON shape (so it can skip parsing). Pick one and justify; my recommendation is HAR 1.2 for tooling interop with everything else that consumes HAR.
- **Voice transcription decision.** Pick one of these and justify:
  - Whisper.wasm in-browser (~30MB download, fully offline, best privacy)
  - Browser native `SpeechRecognition` API (Chrome-only, free, lower quality)
  - Backend transcription (POST audio to the host, which calls Whisper or Anthropic — consistent with the rest of the stack but adds backend dependency)
  - Anthropic Files API + Claude as transcriber (works but Claude isn't optimized for transcription; not recommended)
- **Permissions hygiene.** Request the minimum manifest permissions for v1. `<all_urls>` is unavoidable for `chrome.debugger`, but the popup should require the user to explicitly attach to the active tab — no auto-attach.
- **No external network during capture** beyond the user's own workflow, until the user clicks Submit (which is what triggers the optional POST).

## Out of scope

- **Implementation.** Plan only.
- **Backend API for receiving submissions.** Plan the request/response contract; implementation belongs in a separate task on the `specialist-agent` host side.
- **MITM / proxy capture.** Already covered by `importHar`.
- **Cross-extension data flow** (e.g. integration with password managers).
- **Replay through the extension.** Replay belongs to the agent runtime, not the capture surface.

## What to deliver

Produce a plan file at `prompts/PLANS/browser-extension.md` with these sections:

1. **Architecture diagram.** Service worker, content script (if any), popup UI, options page, message-passing between them. Include the data flow from `chrome.debugger` Network events through scrubbing through storage to the popup preview.

2. **Capture mechanism.**
   - Why `chrome.debugger` over `webRequest` (the response-body issue).
   - Which CDP events you'll subscribe to (`Network.requestWillBeSent`, `Network.responseReceived`, `Network.getResponseBody`, etc.).
   - How you reconstruct full request/response pairs from streaming events.
   - The Firefox path — same intent, different API.

3. **Voice narration design.**
   - Picked transcription option + rationale + fallback.
   - When transcription happens (live during recording, on Stop, or on Submit).
   - How the transcript edits round-trip into the bundle.
   - Whether the audio itself is included in the bundle or discarded after transcription (privacy default: discard).

4. **Auth scrubbing.**
   - Bundle the existing `src/capture/scrub.ts` logic into the extension (re-implement in browser-safe TypeScript or share a package).
   - Specifically when scrubbing happens — recommendation: at capture time, before anything reaches storage.

5. **Output bundle format.** Concrete JSON schema example:
   ```jsonc
   {
     "schemaVersion": "1",
     "intent": "...",            // editable transcript
     "narrative": "...",          // optional richer transcript, full session
     "har": { /* HAR 1.2 */ },
     "audio": null                // or base64 if user opted to retain
   }
   ```

6. **Submission paths.**
   - **Download:** filename convention, MIME type, how the user feeds it to `specialist-agent learn` (likely a new `--bundle=` flag).
   - **POST:** HTTP contract — endpoint URL config in extension options page, headers, body schema, expected 200 / error shapes. Match what the existing `SpecialistAgent.learnFromTrace` would accept upstream.

7. **Permissions.** The minimum-viable Manifest V3 `permissions` and `host_permissions` arrays, with one-line justifications.

8. **Project layout.** Suggested directory structure. Recommended:
   ```
   browser-extension/
     manifest.json
     src/
       background/         # service worker
       content/            # content scripts (if any)
       popup/              # UI
       options/            # config page
       capture/            # CDP wrappers, scrubbing
       voice/              # recording + transcription
       bundle/             # output assembly
       shared/             # types, message contracts
     test/
     vendor/               # whisper.wasm if used
   ```

9. **Testing plan.**
   - **Unit:** auth scrubber matches `src/capture/scrub.ts` byte-for-byte against shared fixtures.
   - **Integration:** record the bundled `examples/stripe-trace` workflow against a Stripe test account, confirm the resulting HAR round-trips through `importHar` and produces an identical wrapper set.
   - **End-to-end:** synthesize a workflow from extension capture, then independently from `examples/stripe-trace.har`, confirm the resulting `services/stripe.ts` is byte-equivalent (modulo timestamps).
   - **Voice:** transcript is non-empty for a 30-second narration of the Stripe workflow.

10. **Installation + migration.**
    - How the user installs (Chrome Web Store target, Firefox AMO target, or unpacked-only for v1).
    - How the user configures the backend endpoint (if any).
    - How this fits into the existing `specialist-agent` workflow — does the user still install the npm package, or does the extension subsume that?

11. **Risks and effort.**
    - The `chrome.debugger` debugging-banner UX risk.
    - The Whisper.wasm bundle-size risk (if you pick that path).
    - Cross-browser parity risk (Firefox debugger API differences).
    - Rough effort estimate per major component (eng-weeks, not eng-hours).

## Length + style

Aim for **600–1000 lines** in the plan file. Specific is better than vague: include exact API signatures, message-type definitions, file paths, and CDP event names. Reference functions in the existing repo by file path + line number.

If a decision genuinely requires user input, flag it in a "Decisions to confirm with user" section at the top — don't punt every choice. Default to the most defensible answer with a one-line rationale.
