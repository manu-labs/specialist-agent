import type { CaptureSession } from "./buffer.js";

/**
 * SDK interceptor: patches `globalThis.fetch` so every outbound HTTP
 * call during the capture window lands in the buffer. This is the
 * "embedded SDK" capture surface from the architecture doc — the
 * browser-extension and MITM-proxy variants produce HAR data which
 * is imported through `har.ts`.
 *
 * Returns a stop() function. Always call it.
 */
export function attachFetchInterceptor(session: CaptureSession): () => void {
  const original = globalThis.fetch;
  if (!original) {
    throw new Error("globalThis.fetch is not available in this runtime.");
  }

  const patched: typeof fetch = async (input, init) => {
    const startedAt = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")) || "GET";
    const reqHeaders = headersToObject(init?.headers);
    const reqBody = await safeReadBody(init?.body);

    let response: Response;
    let error: unknown;
    try {
      response = await original(input as RequestInfo, init);
    } catch (e) {
      error = e;
      throw e;
    } finally {
      if (!error) {
        const duration = Date.now() - startedAt;
        // Clone the response so the caller still gets a fresh body.
        const cloned = (response! as Response).clone();
        const respBody = await safeReadResponseBody(cloned);
        session.add({
          request: {
            method: method.toUpperCase(),
            url,
            headers: reqHeaders,
            body: reqBody,
            timestamp: new Date(startedAt).toISOString(),
          },
          response: {
            status: response!.status,
            headers: headersToObject(response!.headers),
            body: respBody,
            durationMs: duration,
          },
        });
      }
    }
    return response!;
  };

  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = original;
  };
}

function headersToObject(input: HeadersInit | Headers | undefined): Record<string, string> {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input);
  }
  return { ...(input as Record<string, string>) };
}

async function safeReadBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (body == null) return null;
  if (typeof body === "string") return tryJson(body);
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  // For streams, FormData, Blob — capture a marker rather than draining.
  return `[binary or stream body, type=${(body as { constructor?: { name: string } }).constructor?.name ?? typeof body}]`;
}

async function safeReadResponseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return await res.json();
    const text = await res.text();
    return tryJson(text);
  } catch {
    return null;
  }
}

function tryJson(s: string): unknown {
  if (!s) return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
