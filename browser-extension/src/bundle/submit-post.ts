// POST a bundle to the configured synthesis host. The endpoint contract
// is documented in `prompts/PLANS/browser-extension.md` §7.2.

import type { ExtensionConfig } from "../shared/config.js";
import type { Bundle } from "./schema.js";

export interface PostSuccess {
  ok: true;
  status: number;
  traceId?: string;
  learnUrl?: string;
}

export interface PostFailure {
  ok: false;
  status: number;
  errorCode: string;
  detail: string;
}

export type PostResult = PostSuccess | PostFailure;

export async function submitPost(bundle: Bundle, cfg: ExtensionConfig): Promise<PostResult> {
  if (!cfg.postEndpoint) {
    return {
      ok: false,
      status: 0,
      errorCode: "no_endpoint",
      detail: "POST endpoint is not configured. Set one in the options page.",
    };
  }

  const url = `${cfg.postEndpoint.replace(/\/$/, "")}/v1/bundles`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.postBearerToken) headers["Authorization"] = `Bearer ${cfg.postBearerToken}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(bundle) });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorCode: "network",
      detail: (err as Error).message,
    };
  }

  let parsed: { error?: string; detail?: string; traceId?: string; learnUrl?: string } = {};
  try {
    parsed = await res.json();
  } catch {
    /* swallow — non-JSON responses surface via status */
  }

  if (res.ok) {
    return {
      ok: true,
      status: res.status,
      ...(parsed.traceId ? { traceId: parsed.traceId } : {}),
      ...(parsed.learnUrl ? { learnUrl: parsed.learnUrl } : {}),
    };
  }

  return {
    ok: false,
    status: res.status,
    errorCode: parsed.error ?? `http_${res.status}`,
    detail: parsed.detail ?? res.statusText,
  };
}
