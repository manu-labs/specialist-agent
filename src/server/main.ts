#!/usr/bin/env node
// Server entry. Loads config from env, starts Hono on the configured
// port, exits non-zero on misconfiguration so Railway flags the deploy.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ConfigError, parseBundleTokens, TenantResolver } from "./auth.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "";
  const tokens = parseBundleTokens(process.env.BUNDLE_TOKENS);
  const model = process.env.SPECIALIST_MODEL || undefined;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("error: ANTHROPIC_API_KEY is not set — synthesis will fail.");
    process.exit(2);
  }

  let resolver: TenantResolver;
  try {
    resolver = new TenantResolver({ tokens, volumeRoot });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  await resolver.ensureTenantDirs();

  const app = createApp({ resolver, ...(model ? { model } : {}) });

  serve({ fetch: app.fetch, port }, ({ port: bound }) => {
    console.log(
      `[specialist-server] listening on :${bound} — ${resolver.size} tenant(s), volume=${resolver.volumeRoot}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
