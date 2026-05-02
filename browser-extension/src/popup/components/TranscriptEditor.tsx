import React, { useEffect, useRef, useState } from "react";

interface Props {
  intent: string;
  narrative: string;
  onChange: (intent: string, narrative: string) => void;
}

export function TranscriptEditor({ intent, narrative, onChange }: Props) {
  const [localIntent, setLocalIntent] = useState(intent);
  const [localNarrative, setLocalNarrative] = useState(narrative);
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setLocalIntent(intent), [intent]);
  useEffect(() => setLocalNarrative(narrative), [narrative]);

  const schedule = (i: string, n: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(i, n), 300);
  };

  return (
    <>
      <div className="row">
        <input
          type="text"
          placeholder="intent (one line)"
          value={localIntent}
          onChange={(e) => {
            setLocalIntent(e.target.value);
            schedule(e.target.value, localNarrative);
          }}
        />
      </div>
      <div className="row">
        <button onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Hide" : "Show"} narration
        </button>
      </div>
      {expanded && (
        <div className="row">
          <textarea
            placeholder="optional voice/narration text"
            value={localNarrative}
            onChange={(e) => {
              setLocalNarrative(e.target.value);
              schedule(localIntent, e.target.value);
            }}
          />
        </div>
      )}
    </>
  );
}
