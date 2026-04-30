// The auth broker is the only path through which wrappers obtain credentials.
// Providers are tried in order of preference.

export type AuthScheme = "bearer" | "basic" | "header" | "query";

export interface AuthCredential {
  scheme: AuthScheme;
  token: string;
  /** Header name (e.g. "Authorization", "X-Api-Key") or query param name. */
  field?: string;
}

export interface AuthProvider {
  readonly name: string;
  /** Can this provider supply credentials for the given vendor? */
  canHandle(vendor: string): Promise<boolean>;
  /** Return the credential, or throw if not currently available. */
  getCredential(vendor: string): Promise<AuthCredential>;
}

export class AuthBroker {
  private providers: AuthProvider[] = [];

  register(provider: AuthProvider): this {
    this.providers.push(provider);
    return this;
  }

  async getCredential(vendor: string): Promise<AuthCredential> {
    for (const provider of this.providers) {
      if (await provider.canHandle(vendor)) {
        return provider.getCredential(vendor);
      }
    }
    throw new Error(
      `No auth provider available for vendor "${vendor}". Registered: ${this.providers.map((p) => p.name).join(", ") || "(none)"}`,
    );
  }

  /**
   * Apply the credential to a fetch request. Mutates `init` in place.
   * Returns the (possibly modified) URL.
   */
  async applyToRequest(
    vendor: string,
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<string> {
    const cred = await this.getCredential(vendor);
    switch (cred.scheme) {
      case "bearer":
        init.headers["Authorization"] = `Bearer ${cred.token}`;
        return url;
      case "basic":
        init.headers["Authorization"] = `Basic ${cred.token}`;
        return url;
      case "header":
        if (!cred.field) throw new Error("header scheme requires field name");
        init.headers[cred.field] = cred.token;
        return url;
      case "query": {
        if (!cred.field) throw new Error("query scheme requires field name");
        const u = new URL(url);
        u.searchParams.set(cred.field, cred.token);
        return u.toString();
      }
    }
  }
}
