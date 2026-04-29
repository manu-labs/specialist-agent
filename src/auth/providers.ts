import type { AuthCredential, AuthProvider } from "./broker.js";

/**
 * API key provider. Reads from environment variables of the form
 * `<VENDOR>_API_KEY` (uppercased). Use the `scheme` option to control
 * how the credential is applied to outgoing requests.
 */
export class ApiKeyProvider implements AuthProvider {
  readonly name = "api-key";

  constructor(
    private opts: {
      /** "bearer" | "header" | "query" — default "bearer" */
      scheme?: AuthCredential["scheme"];
      /** Required for "header" / "query" schemes. */
      field?: string;
      /** Override env var name; default `<VENDOR>_API_KEY`. */
      envVar?: (vendor: string) => string;
    } = {},
  ) {}

  private envVarFor(vendor: string): string {
    return this.opts.envVar
      ? this.opts.envVar(vendor)
      : `${vendor.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  }

  async canHandle(vendor: string): Promise<boolean> {
    return Boolean(process.env[this.envVarFor(vendor)]);
  }

  async getCredential(vendor: string): Promise<AuthCredential> {
    const envVar = this.envVarFor(vendor);
    const token = process.env[envVar];
    if (!token) {
      throw new Error(`API key for "${vendor}" not found in env var ${envVar}.`);
    }
    return {
      scheme: this.opts.scheme ?? "bearer",
      token,
      field: this.opts.field,
    };
  }
}

/**
 * SDK-embedded provider. The host application supplies credentials via a
 * callback; the agent never sees raw secrets at rest.
 */
export class SdkEmbeddedProvider implements AuthProvider {
  readonly name = "sdk-embedded";

  constructor(
    private resolve: (vendor: string) => Promise<AuthCredential | null>,
  ) {}

  async canHandle(vendor: string): Promise<boolean> {
    return (await this.resolve(vendor)) !== null;
  }

  async getCredential(vendor: string): Promise<AuthCredential> {
    const cred = await this.resolve(vendor);
    if (!cred) throw new Error(`SDK callback returned no credential for "${vendor}".`);
    return cred;
  }
}

/**
 * OAuth provider stub. The full flow (authorize, exchange, refresh) is
 * out of scope for v1 — this only consumes already-issued tokens stored
 * by the host. Refresh logic plugs in via `refreshIfExpired`.
 */
export class OAuthProvider implements AuthProvider {
  readonly name = "oauth";

  constructor(
    private store: {
      get(vendor: string): Promise<{ accessToken: string; expiresAt?: number } | null>;
      refreshIfExpired?(vendor: string): Promise<void>;
    },
  ) {}

  async canHandle(vendor: string): Promise<boolean> {
    return (await this.store.get(vendor)) !== null;
  }

  async getCredential(vendor: string): Promise<AuthCredential> {
    if (this.store.refreshIfExpired) {
      await this.store.refreshIfExpired(vendor);
    }
    const token = await this.store.get(vendor);
    if (!token) throw new Error(`No OAuth token for "${vendor}".`);
    return { scheme: "bearer", token: token.accessToken };
  }
}
