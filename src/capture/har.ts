import { promises as fs } from "node:fs";
import type { HttpTrace } from "../types.js";
import { startCapture } from "./buffer.js";

/**
 * Import an HTTP Archive (HAR) file produced by a browser DevTools
 * export, MITM proxy, or browser-extension capture surface, and turn
 * it into a scrubbed HttpTrace.
 *
 * HAR field reference: http://www.softwareishard.com/blog/har-12-spec/
 */
export async function importHar(filePath: string, intent: string): Promise<HttpTrace> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as HarFile;
  const session = startCapture(intent);

  for (const entry of parsed.log.entries ?? []) {
    const reqHeaders = harHeadersToObject(entry.request.headers);
    const respHeaders = harHeadersToObject(entry.response.headers);
    const reqBody = parseHarPostData(entry.request.postData);
    const respBody = parseHarContent(entry.response.content);

    session.add({
      request: {
        method: entry.request.method.toUpperCase(),
        url: entry.request.url,
        headers: reqHeaders,
        body: reqBody,
        timestamp: entry.startedDateTime,
      },
      response: {
        status: entry.response.status,
        headers: respHeaders,
        body: respBody,
        durationMs: Math.max(0, entry.time ?? 0),
      },
    });
  }

  return session.finish();
}

interface HarFile {
  log: {
    entries: Array<{
      startedDateTime: string;
      time: number;
      request: {
        method: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
        postData?: { mimeType?: string; text?: string };
      };
      response: {
        status: number;
        headers: Array<{ name: string; value: string }>;
        content?: { mimeType?: string; text?: string };
      };
    }>;
  };
}

function harHeadersToObject(arr: Array<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of arr ?? []) out[h.name] = h.value;
  return out;
}

function parseHarPostData(pd: { mimeType?: string; text?: string } | undefined): unknown {
  if (!pd?.text) return null;
  if (pd.mimeType?.includes("application/json")) {
    try {
      return JSON.parse(pd.text);
    } catch {
      return pd.text;
    }
  }
  return pd.text;
}

function parseHarContent(c: { mimeType?: string; text?: string } | undefined): unknown {
  if (!c?.text) return null;
  if (c.mimeType?.includes("application/json")) {
    try {
      return JSON.parse(c.text);
    } catch {
      return c.text;
    }
  }
  return c.text;
}
