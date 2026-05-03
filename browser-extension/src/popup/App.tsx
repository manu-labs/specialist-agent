import React, { useEffect, useState } from "react";
import { useSession } from "./hooks/useSession.js";
import { useStatsPort } from "./hooks/useStatsPort.js";
import { StartStop } from "./components/StartStop.js";
import { StatsPanel } from "./components/StatsPanel.js";
import { HostFilter } from "./components/HostFilter.js";
import { TranscriptEditor } from "./components/TranscriptEditor.js";
import { SubmitMenu } from "./components/SubmitMenu.js";
import { loadConfig } from "../shared/config.js";

export function App() {
  const { snapshot, start, stop, updateIntent, filterHost, downloadFallback, retrySubmit, discard } = useSession();
  const { stats, intent: liveIntent, narrative: liveNarrative, error, submit } = useStatsPort();
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [hasEndpoint, setHasEndpoint] = useState(false);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]?.id != null) setActiveTabId(tabs[0].id);
    });
    void loadConfig().then((cfg) => setHasEndpoint(!!cfg.postEndpoint));
  }, []);

  const intent = liveIntent || snapshot.intent;
  const narrative = liveNarrative || snapshot.narrative;

  const submitState =
    submit.phase !== "idle"
      ? submit
      : snapshot.lastSubmitResult
      ? ({ phase: "done", result: snapshot.lastSubmitResult } as const)
      : ({ phase: "idle" } as const);

  return (
    <>
      <h1>Specialist Capture</h1>
      <StartStop
        active={snapshot.active}
        onStart={(rec) => activeTabId != null && start(activeTabId, rec)}
        onStop={stop}
      />
      <StatsPanel stats={stats} />
      {snapshot.active && (
        <>
          <HostFilter onChange={filterHost} />
          <TranscriptEditor intent={intent} narrative={narrative} onChange={updateIntent} />
          {!hasEndpoint && submitState.phase === "idle" && (
            <div className="stats">
              No host endpoint configured. The bundle will save locally on Stop.{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void chrome.runtime.openOptionsPage();
                }}
              >
                Configure endpoint
              </a>
            </div>
          )}
        </>
      )}
      <SubmitMenu
        submit={submitState}
        hasEndpoint={hasEndpoint}
        onRetry={retrySubmit}
        onDownloadFallback={downloadFallback}
        onDiscard={discard}
        onConfigure={() => void chrome.runtime.openOptionsPage()}
      />
      {error && (
        <div className="error">
          {error.code}: {error.detail}
        </div>
      )}
      <div className="privacy">
        Voice transcription uses Chrome's built-in speech recognition, which may send audio to Google.
        Toggle Whisper in options to transcribe offline.
      </div>
    </>
  );
}
