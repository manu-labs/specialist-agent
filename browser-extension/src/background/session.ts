// CaptureSession owns the lifecycle of a single recording: attaches the
// CDP adapter, accumulates exchanges + audio, computes stats, and hands
// back a Bundle on demand.

import { startCapture, type CaptureSession as InMemSession } from "../capture/buffer.js";
import { buildBundle } from "../bundle/build.js";
import type { Bundle } from "../bundle/schema.js";
import type { HttpExchange, CaptureStats } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import type { CaptureAdapter } from "./cdp/adapter.js";
import { ChromeDebuggerAdapter } from "./cdp/chrome-debugger.js";
import { clearCapture, persistCapture, type PersistedCapture } from "./storage.js";

export interface CaptureSessionOptions {
  tabId: number;
  tabUrl?: string;
  recordAudio: boolean;
  bodyMaxBytes: number;
  hostFilterMode: "all" | "allowlist";
  hostAllowlist: string[];
  extensionVersion: string;
  browser: string;
}

export interface CaptureSessionEvents {
  onStats?: (stats: CaptureStats) => void;
  onError?: (e: { code: string; detail: string }) => void;
}

export class CaptureSessionRunner {
  readonly opts: CaptureSessionOptions;
  private events: CaptureSessionEvents = {};
  private adapter: CaptureAdapter;
  private buffer: InMemSession;
  private intent = "";
  private narrative = "";
  private hostFilterPattern: string | null = null;
  private audio: { mimeType: string; bytes: ArrayBuffer; durationMs: number } | null = null;
  private audioPromise: Promise<void> | null = null;
  private audioResolver: (() => void) | null = null;
  private byHost = new Map<string, { count: number; bytes: number }>();
  private totalBytes = 0;
  private startedAt: string;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CaptureSessionOptions, events: CaptureSessionEvents = {}) {
    this.opts = opts;
    this.events = events;
    this.startedAt = new Date().toISOString();
    this.buffer = startCapture("");
    this.adapter = new ChromeDebuggerAdapter({ bodyMaxBytes: opts.bodyMaxBytes });
    this.adapter.onExchange((e) => this.handleExchange(e));
    this.adapter.onError((e) => this.events.onError?.(e));
    this.adapter.onNavigation((url) => logger.info("nav boundary", url));
  }

  get tabId(): number {
    return this.opts.tabId;
  }

  async start(): Promise<void> {
    await this.adapter.attach(this.opts.tabId);
    this.statsTimer = setInterval(() => this.events.onStats?.(this.snapshot()), 250);
  }

  async stop(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    await this.adapter.detach(this.opts.tabId);
    await this.persist(true);
  }

  setEvents(events: CaptureSessionEvents): void {
    this.events = events;
  }

  setIntent(intent: string, narrative?: string): void {
    this.intent = intent;
    if (narrative !== undefined) this.narrative = narrative;
    void this.persist();
  }

  setHostFilter(pattern: string | null): void {
    this.hostFilterPattern = pattern;
    void this.persist();
  }

  setAudio(audio: { mimeType: string; bytes: ArrayBuffer; durationMs: number } | null): void {
    this.audio = audio;
    this.audioResolver?.();
    this.audioResolver = null;
    void this.persist();
  }

  /**
   * Returns a promise that resolves once `setAudio` is called, or after
   * `timeoutMs` elapses (so a misbehaving offscreen doc can't wedge the
   * stop flow forever). Idempotent — calling again before resolution
   * returns the same promise.
   */
  awaitAudio(timeoutMs: number): Promise<void> {
    if (this.audioPromise) return this.audioPromise;
    this.audioPromise = new Promise<void>((resolve) => {
      this.audioResolver = resolve;
      setTimeout(() => {
        if (this.audioResolver) {
          this.audioResolver();
          this.audioResolver = null;
        }
      }, timeoutMs);
    });
    return this.audioPromise;
  }

  snapshot(): CaptureStats {
    const byHost: Record<string, { count: number; bytes: number }> = {};
    for (const [host, v] of this.byHost) byHost[host] = { ...v };
    return {
      exchangeCount: this.buffer.exchanges.length,
      totalBytes: this.totalBytes,
      byHost,
      startedAt: this.startedAt,
      durationMs: Date.now() - new Date(this.startedAt).getTime(),
    };
  }

  exchanges(): HttpExchange[] {
    return this.buffer.exchanges;
  }

  intentText(): string {
    return this.intent;
  }

  narrativeText(): string {
    return this.narrative;
  }

  buildBundle(includeAudio: boolean): Bundle {
    const filterFn = this.compileHostFilter();
    return buildBundle({
      intent: this.intent || "(no intent provided)",
      narrative: this.narrative || undefined,
      exchanges: this.buffer.exchanges,
      audio: includeAudio ? this.audio : null,
      hostFilter: filterFn,
      extensionVersion: this.opts.extensionVersion,
      browser: this.opts.browser,
      tabUrl: this.opts.tabUrl,
    });
  }

  private compileHostFilter(): ((host: string) => boolean) | null {
    if (this.opts.hostFilterMode === "allowlist" && this.opts.hostAllowlist.length > 0) {
      const allow = new Set(this.opts.hostAllowlist.map((h) => h.toLowerCase()));
      const userPattern = this.hostFilterPattern?.toLowerCase() ?? null;
      return (host) => {
        const h = host.toLowerCase();
        if (!allow.has(h) && !anyMatchesSuffix(allow, h)) return false;
        if (userPattern && !h.includes(userPattern)) return false;
        return true;
      };
    }
    if (this.hostFilterPattern) {
      const p = this.hostFilterPattern.toLowerCase();
      return (host) => host.toLowerCase().includes(p);
    }
    return null;
  }

  private handleExchange(e: Omit<HttpExchange, "index">): void {
    this.buffer.add(e);
    const bytes = approxBytes(e);
    this.totalBytes += bytes;
    try {
      const host = new URL(e.request.url).host;
      const cur = this.byHost.get(host) ?? { count: 0, bytes: 0 };
      cur.count++;
      cur.bytes += bytes;
      this.byHost.set(host, cur);
    } catch {
      /* navigation rows may have non-URL "url" — ignore */
    }
    void this.persist();
  }

  private async persist(force = false): Promise<void> {
    const state: PersistedCapture = {
      sessionId: this.buffer.id,
      startedAt: this.startedAt,
      intent: this.intent,
      narrative: this.narrative,
      exchanges: this.buffer.exchanges,
      audio: this.audio
        ? {
            mimeType: this.audio.mimeType,
            base64: arrayBufferToBase64(this.audio.bytes),
            durationMs: this.audio.durationMs,
          }
        : null,
      hostFilter: this.hostFilterPattern,
      tabId: this.opts.tabId,
      tabUrl: this.opts.tabUrl ?? null,
    };
    await persistCapture(state, force);
  }

  async discard(): Promise<void> {
    await clearCapture();
  }
}

function approxBytes(e: Omit<HttpExchange, "index">): number {
  let n = 0;
  n += JSON.stringify(e.request.headers).length;
  n += JSON.stringify(e.response.headers).length;
  n += sizeOfBody(e.request.body);
  n += sizeOfBody(e.response.body);
  return n;
}

function sizeOfBody(b: unknown): number {
  if (b == null) return 0;
  if (typeof b === "string") return b.length;
  try {
    return JSON.stringify(b).length;
  } catch {
    return 0;
  }
}

function anyMatchesSuffix(set: Set<string>, host: string): boolean {
  for (const entry of set) {
    if (entry.startsWith("*.")) {
      const suf = entry.slice(1);
      if (host.endsWith(suf)) return true;
    }
  }
  return false;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
