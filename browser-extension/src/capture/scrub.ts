// Scrub auth headers and tokens out of captures before they hit storage.
// We replace recognized auth values with {{auth}} placeholders so the
// trace remains structurally faithful but no secrets are persisted.
//
// PORT NOTE: kept byte-for-byte identical to `src/capture/scrub.ts` in the
// host package. The shared fixture `test/fixtures/scrub-cases.json` runs
// against both copies in CI; any drift fails the build.

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = AUTH_HEADER_NAMES.has(k.toLowerCase()) ? "{{auth}}" : v;
  }
  return out;
}

export function scrubBody(body: unknown): unknown {
  if (body == null) return body;
  if (typeof body === "string") {
    return body.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1{{auth}}");
  }
  if (Array.isArray(body)) return body.map(scrubBody);
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (looksLikeSecretKey(k)) {
        out[k] = "{{auth}}";
      } else {
        out[k] = scrubBody(v);
      }
    }
    return out;
  }
  return body;
}

function looksLikeSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("api_key") ||
    k.includes("apikey") ||
    k.includes("access_token") ||
    k.includes("refresh_token") ||
    k.includes("client_secret") ||
    k === "password" ||
    k === "secret"
  );
}
