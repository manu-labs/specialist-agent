// Web Speech API wrapper. Chrome-only; sends audio to Google for
// transcription. Surfaced in the popup with a privacy note.

type AnyWindow = typeof window & {
  webkitSpeechRecognition?: new () => SpeechRecognition;
  SpeechRecognition?: new () => SpeechRecognition;
};

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string; confidence: number };
}

export interface WebSpeechHandle {
  stop(): void;
}

export function startWebSpeech(
  onPartial: (text: string, isFinal: boolean) => void,
): WebSpeechHandle | null {
  const w = self as unknown as AnyWindow;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let interim = "";
    let final = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const t = r[0].transcript;
      if (r.isFinal) final += t;
      else interim += t;
    }
    if (final) onPartial(final.trim(), true);
    else if (interim) onPartial(interim.trim(), false);
  };
  rec.onerror = () => {
    /* swallow — we still have the audio blob */
  };
  rec.start();
  return {
    stop() {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
