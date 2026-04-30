import { AuthBroker } from "../auth/broker.js";
import { ApiKeyProvider, SdkEmbeddedProvider } from "../auth/providers.js";

/**
 * Helper used by every generated wrapper function. Builds a fetch
 * request, injects auth via the AuthBroker, sends it, and returns
 * the parsed body. Failures throw with the response status and body.
 *
 * This is the only HTTP touchpoint for wrappers — keeping wrappers
 * thin in exactly one place.
 */
export interface RunWrapperOptions {
  vendor: string;
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Inject auth — defaults to true. Set false for endpoints that don't need it. */
  auth?: boolean;
}

export async function runWrapper(opts: RunWrapperOptions): Promise<unknown> {
  const broker = getDefaultBroker();
  const headers: Record<string, string> = {
    "content-type": opts.body ? "application/json" : "application/x-www-form-urlencoded",
    accept: "application/json",
    ...(opts.headers ?? {}),
  };

  let url = opts.url;
  if (opts.auth !== false) {
    url = await broker.applyToRequest(opts.vendor, url, { headers });
  }

  const init: RequestInit = {
    method: opts.method.toUpperCase(),
    headers,
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown = text;
  if (text && response.headers.get("content-type")?.includes("application/json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave as raw text — wrapper caller can decide what to do.
    }
  }

  if (!response.ok) {
    const err = new WrapperHttpError(
      `${opts.method.toUpperCase()} ${opts.url} — ${response.status} ${response.statusText}`,
      response.status,
      parsed,
    );
    throw err;
  }

  return parsed;
}

export class WrapperHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "WrapperHttpError";
  }
}

/**
 * The default broker is wired up from environment variables. Hosts
 * embedding the agent (the "SDK-embedded" path from the architecture
 * doc) can override this via `setDefaultBroker`.
 */
let _broker: AuthBroker | undefined;

export function setDefaultBroker(broker: AuthBroker): void {
  _broker = broker;
}

export function getDefaultBroker(): AuthBroker {
  if (!_broker) {
    _broker = new AuthBroker()
      .register(new ApiKeyProvider({ scheme: "bearer" }))
      .register(
        new SdkEmbeddedProvider(async () => null), // host can replace this
      );
  }
  return _broker;
}
