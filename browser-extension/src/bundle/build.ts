// Assemble a Bundle from a finished capture session.

import { emitHar } from "../capture/har-emit.js";
import type { HttpExchange } from "../shared/types.js";
import { BundleSchema, type Bundle } from "./schema.js";

export interface BuildBundleInput {
  intent: string;
  narrative?: string;
  exchanges: HttpExchange[];
  audio: { mimeType: string; bytes: ArrayBuffer; durationMs: number } | null;
  hostFilter?: ((host: string) => boolean) | null;
  extensionVersion: string;
  browser: string;
  tabUrl?: string;
}

export function buildBundle(input: BuildBundleInput): Bundle {
  const filtered = input.hostFilter
    ? input.exchanges.filter((e) => keepExchange(e, input.hostFilter!))
    : input.exchanges;

  const har = emitHar(filtered, {
    creator: { name: "specialist-extension", version: input.extensionVersion },
  });

  const bundle: Bundle = {
    schemaVersion: "1",
    intent: input.intent,
    ...(input.narrative ? { narrative: input.narrative } : {}),
    har,
    audio: input.audio
      ? {
          mimeType: input.audio.mimeType,
          base64: arrayBufferToBase64(input.audio.bytes),
          durationMs: input.audio.durationMs,
        }
      : null,
    metadata: {
      capturedBy: "specialist-extension",
      extensionVersion: input.extensionVersion,
      browser: input.browser,
      capturedAt: new Date().toISOString(),
      ...(input.tabUrl ? { tabUrl: input.tabUrl } : {}),
    },
  };

  return BundleSchema.parse(bundle);
}

function keepExchange(e: HttpExchange, predicate: (host: string) => boolean): boolean {
  try {
    return predicate(new URL(e.request.url).host);
  } catch {
    return false;
  }
}

export function bundleFilename(date = new Date()): string {
  const iso = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const id = shortId();
  return `specialist-bundle-${iso}-${id}.json`;
}

function shortId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return base32(uuid).slice(0, 6);
}

function base32(hex: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    out += alphabet[byte % 32];
  }
  return out;
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
