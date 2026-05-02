import { useEffect, useState, useCallback } from "react";
import type { ClientMessage } from "../../shared/messages.js";

export interface SessionSnapshot {
  active: boolean;
  intent: string;
  narrative: string;
}

export function useSession() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>({
    active: false,
    intent: "",
    narrative: "",
  });

  useEffect(() => {
    void send({ type: "POPUP_TO_BG_GET_SNAPSHOT" }).then((res: any) => {
      if (res?.active) {
        setSnapshot({ active: true, intent: res.intent ?? "", narrative: res.narrative ?? "" });
      }
    });
  }, []);

  const start = useCallback(async (tabId: number, recordAudio: boolean) => {
    await send({ type: "POPUP_TO_BG_START_RECORDING", tabId, recordAudio });
    setSnapshot((s) => ({ ...s, active: true }));
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

  const submitDownload = useCallback(async () => {
    return send({ type: "POPUP_TO_BG_SUBMIT_DOWNLOAD" });
  }, []);

  const submitPost = useCallback(async () => {
    return send({ type: "POPUP_TO_BG_SUBMIT_POST" });
  }, []);

  const discard = useCallback(async () => {
    await send({ type: "POPUP_TO_BG_DISCARD" });
    setSnapshot({ active: false, intent: "", narrative: "" });
  }, []);

  return { snapshot, start, stop, updateIntent, filterHost, submitDownload, submitPost, discard };
}

function send(msg: ClientMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}
