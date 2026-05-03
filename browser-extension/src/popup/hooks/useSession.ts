import { useEffect, useState, useCallback } from "react";
import type { ClientMessage, SubmitResult } from "../../shared/messages.js";

export interface SessionSnapshot {
  active: boolean;
  intent: string;
  narrative: string;
  lastSubmitResult: SubmitResult | null;
}

export function useSession() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>({
    active: false,
    intent: "",
    narrative: "",
    lastSubmitResult: null,
  });

  useEffect(() => {
    void send({ type: "POPUP_TO_BG_GET_SNAPSHOT" }).then((res: any) => {
      setSnapshot({
        active: !!res?.active,
        intent: res?.intent ?? "",
        narrative: res?.narrative ?? "",
        lastSubmitResult: res?.lastSubmitResult ?? null,
      });
    });
  }, []);

  const start = useCallback(async (tabId: number, recordAudio: boolean) => {
    await send({ type: "POPUP_TO_BG_START_RECORDING", tabId, recordAudio });
    setSnapshot((s) => ({ ...s, active: true, lastSubmitResult: null }));
  }, []);

  const stop = useCallback(async () => {
    await send({ type: "POPUP_TO_BG_STOP_RECORDING" });
  }, []);

  const updateIntent = useCallback(async (intent: string, narrative: string) => {
    setSnapshot((s) => ({ ...s, intent, narrative }));
    await send({ type: "POPUP_TO_BG_UPDATE_INTENT", intent, narrative });
  }, []);

  const filterHost = useCallback(async (pattern: string | null) => {
    await send({ type: "POPUP_TO_BG_FILTER_HOST", hostPattern: pattern });
  }, []);

  const downloadFallback = useCallback(async () => {
    return send({ type: "POPUP_TO_BG_DOWNLOAD_FALLBACK" });
  }, []);

  const retrySubmit = useCallback(async () => {
    return send({ type: "POPUP_TO_BG_RETRY_SUBMIT" });
  }, []);

  const discard = useCallback(async () => {
    await send({ type: "POPUP_TO_BG_DISCARD" });
    setSnapshot({ active: false, intent: "", narrative: "", lastSubmitResult: null });
  }, []);

  return { snapshot, start, stop, updateIntent, filterHost, downloadFallback, retrySubmit, discard };
}

function send(msg: ClientMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}
