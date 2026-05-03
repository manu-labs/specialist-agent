// Browser port of `src/capture/buffer.ts`. Identical semantics; uses the
// platform `crypto.randomUUID()` instead of `node:crypto`.

import type { HttpExchange, HttpTrace } from "../shared/types.js";
import { scrubBody, scrubHeaders } from "./scrub.js";

export interface CaptureSession {
  id: string;
  startedAt: string;
  intent: string;
  exchanges: HttpExchange[];
  add(exchange: Omit<HttpExchange, "index">): void;
  finish(): HttpTrace;
}

export function startCapture(intent: string): CaptureSession {
  const exchanges: HttpExchange[] = [];
  return {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    intent,
    exchanges,
    add(exchange) {
      const scrubbed: HttpExchange = {
        index: exchanges.length,
        request: {
          ...exchange.request,
          headers: scrubHeaders(exchange.request.headers),
          body: scrubBody(exchange.request.body),
        },
        response: {
          ...exchange.response,
          headers: scrubHeaders(exchange.response.headers),
          body: scrubBody(exchange.response.body),
        },
      };
      exchanges.push(scrubbed);
    },
    finish(): HttpTrace {
      return {
        id: this.id,
        startedAt: this.startedAt,
        endedAt: new Date().toISOString(),
        intent: this.intent,
        requests: [...exchanges],
      };
    },
  };
}
