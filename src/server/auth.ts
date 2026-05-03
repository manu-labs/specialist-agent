// Bearer-token → tenant resolution + Railway volume enforcement.
//
// All tenant workspaces MUST live under RAILWAY_VOLUME_MOUNT_PATH so
// that container restarts don't wipe per-tenant git history. The
// resolver fails fast at startup — the server refuses to boot if any
// configured tenant path resolves outside the volume.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { TenantConfig } from "../types.js";

export interface TenantResolverOptions {
  /** Map of bearer token → tenant workspace path. */
  tokens: Record<string, string>;
  /** Required: every tenant path must resolve under this directory. */
  volumeRoot: string;
}

export interface ResolvedTenant {
  config: TenantConfig;
  /** The bearer token that resolved to this tenant. */
  token: string;
}

export class TenantResolver {
  private readonly byToken: Map<string, TenantConfig>;
  readonly volumeRoot: string;

  constructor(opts: TenantResolverOptions) {
    if (!opts.volumeRoot) {
      throw new ConfigError(
        "RAILWAY_VOLUME_MOUNT_PATH is not set. The server refuses to start without a persistent volume " +
          "— tenant git history would be lost on every redeploy.",
      );
    }
    if (Object.keys(opts.tokens).length === 0) {
      throw new ConfigError(
        "BUNDLE_TOKENS is empty. Configure at least one bearer-token → tenant-path mapping.",
      );
    }

    const volumeRoot = path.resolve(opts.volumeRoot);
    this.volumeRoot = volumeRoot;
    this.byToken = new Map();

    for (const [token, tenantPath] of Object.entries(opts.tokens)) {
      const resolved = path.resolve(tenantPath);
      if (!isUnder(resolved, volumeRoot)) {
        throw new ConfigError(
          `Tenant path "${tenantPath}" resolves to "${resolved}", which is not under the configured ` +
            `volume "${volumeRoot}". Move the tenant directory inside the Railway volume.`,
        );
      }
      this.byToken.set(token, {
        id: path.basename(resolved),
        workspacePath: resolved,
      });
    }
  }

  /**
   * Look up a tenant from an `Authorization: Bearer <token>` header.
   * Returns null if the header is missing/malformed or the token is
   * unknown — caller should respond 401.
   */
  resolveBearer(authHeader: string | undefined): ResolvedTenant | null {
    if (!authHeader) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!m) return null;
    const token = m[1]!;
    const config = this.byToken.get(token);
    if (!config) return null;
    return { config, token };
  }

  /**
   * Idempotent: ensure every configured tenant directory exists.
   * Volume root is already mounted by Railway; tenant subdirs may not
   * exist yet on a fresh deploy.
   */
  async ensureTenantDirs(): Promise<void> {
    for (const cfg of this.byToken.values()) {
      await fs.mkdir(cfg.workspacePath, { recursive: true });
    }
  }

  /** Number of configured tenants — useful for logging and health. */
  get size(): number {
    return this.byToken.size;
  }
}

export class ConfigError extends Error {}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Parse the BUNDLE_TOKENS env var. Two accepted forms:
 *   1. CSV: "token1:tenants/acme,token2:tenants/foo"
 *   2. JSON: '{"token1":"tenants/acme","token2":"tenants/foo"}'
 * Whitespace around tokens and paths is trimmed.
 */
export function parseBundleTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError("BUNDLE_TOKENS JSON must be an object of token → path");
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ConfigError(`BUNDLE_TOKENS["${k}"] must be a string path`);
      }
      out[k.trim()] = v.trim();
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(",")) {
    if (!pair.trim()) continue;
    const sep = pair.indexOf(":");
    if (sep < 0) {
      throw new ConfigError(
        `BUNDLE_TOKENS entry "${pair}" must be of the form "<token>:<path>"`,
      );
    }
    const token = pair.slice(0, sep).trim();
    const tenantPath = pair.slice(sep + 1).trim();
    if (!token || !tenantPath) {
      throw new ConfigError(`BUNDLE_TOKENS entry "${pair}" is missing token or path`);
    }
    out[token] = tenantPath;
  }
  return out;
}
