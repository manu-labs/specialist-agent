import React, { useEffect, useState } from "react";
import { useSession } from "./hooks/useSession.js";
import { useStatsPort } from "./hooks/useStatsPort.js";
import { StartStop } from "./components/StartStop.js";
import { StatsPanel } from "./components/StatsPanel.js";
import { HostFilter } from "./components/HostFilter.js";
import { TranscriptEditor } from "./components/TranscriptEditor.js";
import { SubmitMenu } from "./components/SubmitMenu.js";

export function App() {
  const { snapshot, start, stop, updateIntent, filterHost, submitDownload, submitPost, discard } = useSession();
  const { stats, intent: liveIntent, narrative: liveNarrative, error } = useStatsPort();
  const [activeTabId, setActiveTabId] = useState<number | null>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]?.id != null) setActiveTabId(tabs[0].id);
    });
  }, []);

  const intent = liveIntent || snapshot.intent;
  const narrative = liveNarrative || snapshot.narrative;

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
          <SubmitMenu onDownload={submitDownload} onPost={submitPost} onDiscard={discard} />
        </>
      )}
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
