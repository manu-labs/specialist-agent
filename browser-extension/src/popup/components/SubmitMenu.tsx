import React from "react";
import type { SubmitResult } from "../../shared/messages.js";
import type { SubmitState } from "../hooks/useStatsPort.js";

interface Props {
  submit: SubmitState;
  hasEndpoint: boolean;
  onRetry: () => Promise<unknown>;
  onDownloadFallback: () => Promise<unknown>;
  onDiscard: () => Promise<void>;
  onConfigure: () => void;
}

/**
 * Auto-submit status panel. The extension POSTs to the configured
 * backend automatically on Stop. This panel shows progress + result;
 * the user only needs to act when something went wrong.
 */
export function SubmitMenu({ submit, hasEndpoint, onRetry, onDownloadFallback, onDiscard, onConfigure }: Props) {
  if (submit.phase === "idle") return null;
  if (submit.phase === "pending") {
    return (
      <div className="stats">
        {hasEndpoint ? "Submitting to host…" : "Saving bundle…"}
      </div>
    );
  }
  return (
    <>
      {renderResult(submit.result)}
      <div className="row">
        {submit.result.kind === "downloaded" && submit.result.reason !== "no_endpoint" && (
          <button onClick={() => onRetry()}>Retry submit</button>
        )}
        {submit.result.kind === "failed" && (
          <>
            <button onClick={() => onRetry()}>Retry submit</button>
            <button onClick={() => onDownloadFallback()}>Save locally</button>
          </>
        )}
        {submit.result.kind === "downloaded" && submit.result.reason === "no_endpoint" && (
          <button onClick={onConfigure}>Configure endpoint</button>
        )}
        <button onClick={() => onDiscard()}>Done</button>
      </div>
    </>
  );
}

function renderResult(r: SubmitResult): React.ReactNode {
  if (r.kind === "posted") {
    return (
      <div className="stats">
        Submitted to host{r.traceId ? ` (trace ${r.traceId})` : ""}
        {r.learnUrl && (
          <>
            {" — "}
            <a href={r.learnUrl} target="_blank" rel="noreferrer">
              view
            </a>
          </>
        )}
        .
      </div>
    );
  }
  if (r.kind === "downloaded") {
    if (r.reason === "no_endpoint") {
      return (
        <div className="stats">
          No host endpoint configured — saved <code>{r.filename}</code> locally instead.
        </div>
      );
    }
    return (
      <div className="error">
        Submit to host failed ({r.postError ?? "unknown"}). Saved <code>{r.filename}</code> locally as a fallback.
      </div>
    );
  }
  return (
    <div className="error">
      Submit failed: {r.errorCode} — {r.detail}
    </div>
  );
}
