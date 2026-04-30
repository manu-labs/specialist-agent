import { randomUUID } from "node:crypto";
import type { HttpExchange, HttpTrace } from "../types.js";
import { scrubBody, scrubHeaders } from "./scrub.js";

export interface CaptureSession {
  id: string;
  startedAt: string;
  intent: string;
  exchanges: HttpExchange[];
  add(exchange: Omit<HttpExchange, "index">): void;
  finish(): HttpTrace;
}

/**
 * In-memory buffer for HTTP exchanges. The capture layer (SDK
 * interceptor or HAR importer) feeds exchanges in; the user marks
 * end of task and we hand back a finalized HttpTrace.
 *
 * Auth scrubbing happens here, on the way in — nothing sensitive is
 * stored in memory beyond the duration of a single request.
 */
export function startCapture(intent: string): CaptureSession {
  const exchanges: HttpExchange[] = [];
  return {
    id: randomUUID(),
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
