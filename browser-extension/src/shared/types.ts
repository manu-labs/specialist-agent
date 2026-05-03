// Mirrors `src/types.ts` from the host package. Kept identical so the
// extension's HAR emit and the host's HAR import speak the same shape.

export interface HttpTrace {
  id: string;
  startedAt: string;
  endedAt: string;
  intent: string;
  requests: HttpExchange[];
}

export interface HttpExchange {
  index: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    timestamp: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
  };
}

export interface CaptureStats {
  exchangeCount: number;
  totalBytes: number;
  byHost: Record<string, { count: number; bytes: number }>;
  startedAt: string;
  durationMs: number;
}

export interface BundleSummary {
  filename: string;
  bytes: number;
  exchangeCount: number;
  hasAudio: boolean;
}

export type ErrorCode =
  | "cdp_attach_failed"
  | "devtools_open"
  | "tab_closed"
  | "offscreen_failed"
  | "media_permission_denied"
  | "post_failed"
  | "bundle_too_large"
  | "internal";
