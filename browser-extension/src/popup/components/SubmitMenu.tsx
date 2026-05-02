import React, { useState } from "react";

interface Props {
  onDownload: () => Promise<unknown>;
  onPost: () => Promise<unknown>;
  onDiscard: () => Promise<void>;
}

export function SubmitMenu({ onDownload, onPost, onDiscard }: Props) {
  const [busy, setBusy] = useState<"none" | "download" | "post" | "discard">("none");
  const [result, setResult] = useState<string | null>(null);

  const guard = async (kind: "download" | "post" | "discard", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setResult(null);
    try {
      const r = (await fn()) as { ok?: boolean; status?: number; filename?: string; errorCode?: string; detail?: string; traceId?: string };
      if (r?.ok === false) setResult(`error: ${r.errorCode ?? "unknown"} — ${r.detail ?? ""}`);
      else if (r?.filename) setResult(`saved ${r.filename}`);
      else if (r?.traceId) setResult(`accepted (trace ${r.traceId})`);
      else if (kind === "post" && r?.status && r.status >= 200 && r.status < 300) setResult(`posted (status ${r.status})`);
      else if (kind === "discard") setResult("discarded");
      else setResult("done");
    } catch (e) {
      setResult(`error: ${(e as Error).message}`);
    } finally {
      setBusy("none");
    }
  };

  return (
    <>
      <div className="row">
        <button disabled={busy !== "none"} onClick={() => guard("download", onDownload)}>
          {busy === "download" ? "…" : "Download bundle"}
        </button>
        <button disabled={busy !== "none"} onClick={() => guard("post", onPost)}>
          {busy === "post" ? "…" : "Submit to host"}
        </button>
        <button disabled={busy !== "none"} onClick={() => guard("discard", onDiscard)}>
          Discard
        </button>
      </div>
      {result && <div className="stats">{result}</div>}
    </>
  );
}
