import React, { useState } from "react";

interface Props {
  active: boolean;
  onStart: (recordAudio: boolean) => void;
  onStop: () => void;
}

export function StartStop({ active, onStart, onStop }: Props) {
  const [recordAudio, setRecordAudio] = useState(false);
  return (
    <div className="row">
      {active ? (
        <button className="danger" onClick={onStop}>
          Stop
        </button>
      ) : (
        <>
          <button className="primary" onClick={() => onStart(recordAudio)}>
            Start
          </button>
          <label>
            <input
              type="checkbox"
              checked={recordAudio}
              onChange={(e) => setRecordAudio(e.target.checked)}
            />{" "}
            narrate aloud
          </label>
        </>
      )}
    </div>
  );
}
