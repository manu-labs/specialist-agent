import React, { useState } from "react";

interface Props {
  onChange: (pattern: string | null) => void;
}

export function HostFilter({ onChange }: Props) {
  const [value, setValue] = useState("");
  return (
    <div className="row">
      <input
        type="text"
        placeholder="filter by host (substring) — blank = include all"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onChange(e.target.value.trim() || null);
        }}
      />
    </div>
  );
}
