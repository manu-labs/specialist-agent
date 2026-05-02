import { useEffect, useState } from "react";
import type { ServerMessage } from "../../shared/messages.js";
import { POPUP_STATS_PORT } from "../../shared/messages.js";
import type { CaptureStats, ErrorCode } from "../../shared/types.js";

export interface PortState {
  stats: CaptureStats | null;
  intent: string;
  narrative: string;
  error: { code: ErrorCode; detail: string } | null;
}

export function useStatsPort(): PortState {
  const [state, setState] = useState<PortState>({
    stats: null,
    intent: "",
    narrative: "",
    error: null,
  });

  useEffect(() => {
    const port = chrome.runtime.connect({ name: POPUP_STATS_PORT });
    const listener = (msg: ServerMessage) => {
      if (msg.type === "BG_TO_POPUP_CAPTURE_STATS") {
        setState((s) => ({ ...s, stats: msg.stats }));
      } else if (msg.type === "BG_TO_POPUP_TRANSCRIPT") {
        setState((s) => ({ ...s, intent: msg.intent, narrative: msg.narrative }));
      } else if (msg.type === "BG_TO_POPUP_ERROR") {
        setState((s) => ({ ...s, error: { code: msg.code, detail: msg.detail } }));
      }
    };
    port.onMessage.addListener(listener);
    return () => {
      port.onMessage.removeListener(listener);
      port.disconnect();
    };
  }, []);

  return state;
}
