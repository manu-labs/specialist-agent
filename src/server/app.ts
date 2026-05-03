// Hono app factory. Separated from `main.ts` so tests can run the same
// pipeline without binding a port.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { SpecialistAgent } from "../agent.js";
import { BundleSchema } from "../bundle/schema.js";
import type { TenantConfig } from "../types.js";
import { processBundle, type HandlerDeps } from "./handler.js";
import { TenantResolver } from "./auth.js";

export interface AppOptions {
  resolver: TenantResolver;
  /** Body-size cap in bytes. Defaults to 50 MiB to match plan §7.2 / 413. */
  maxBodyBytes?: number;
  /** Override the model passed to SpecialistAgent. */
  model?: string;
  /** Test seam — replace the real SpecialistAgent. */
  agentFor?: HandlerDeps["agentFor"];
  /** Test seam — disable request logger. */
  logRequests?: boolean;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BYTES;

  if (opts.logRequests !== false) {
    app.use("*", logger());
  }
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["POST", "GET", "OPTIONS"] }));

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      tenants: opts.resolver.size,
      volumeRoot: opts.resolver.volumeRoot,
    }),
  );

  app.post("/v1/bundles", async (c) => {
    const tenant = opts.resolver.resolveBearer(c.req.header("Authorization"));
    if (!tenant) {
      throw new HTTPException(401, {
        message: JSON.stringify({ error: "unauthorized", detail: "missing or invalid bearer token" }),
      });
    }

    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (contentLength > maxBodyBytes) {
      throw new HTTPException(413, {
        message: JSON.stringify({ error: "bundle_too_large", detail: `bundle exceeds ${maxBodyBytes} byte limit` }),
      });
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      throw new HTTPException(400, {
        message: JSON.stringify({ error: "invalid_json", detail: (err as Error).message }),
      });
    }

    const parsed = BundleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          error: "invalid_bundle",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        }),
      });
    }

    const agentFor: HandlerDeps["agentFor"] =
      opts.agentFor ??
      ((t: TenantConfig) =>
        new SpecialistAgent({
          tenant: t,
          ...(opts.model ? { model: opts.model } : {}),
        }));

    const result = await processBundle(parsed.data, tenant.config, { agentFor });

    if (result.ok) {
      return c.json({
        accepted: true,
        traceId: result.traceId,
        workflow: result.workflow,
        wrappers: result.wrappers,
        commit: result.commit,
        tenant: result.tenant,
      });
    }
    throw new HTTPException(result.status as 400 | 500, {
      message: JSON.stringify({ error: result.error, detail: result.detail }),
    });
  });

  // Hono's default error handler stringifies HTTPException.message into
  // a text body. We want JSON with the right Content-Type on every
  // error path — extension parses `error` + `detail`.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      try {
        return c.json(JSON.parse(err.message), err.status);
      } catch {
        return c.json({ error: "internal", detail: err.message }, err.status);
      }
    }
    return c.json({ error: "internal", detail: err.message }, 500);
  });

  return app;
}
