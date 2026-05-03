// Source-of-truth zod schema for the on-disk bundle. Mirrored verbatim
// at `src/bundle/schema.ts` in the host package. The shared fixture
// `test/fixtures/bundle-example.json` is parsed by both copies so any
// drift fails CI.

import { z } from "zod";

const HarHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const HarPostDataSchema = z.object({
  mimeType: z.string(),
  text: z.string(),
});

const HarContentSchema = z.object({
  mimeType: z.string(),
  text: z.string(),
  size: z.number().optional(),
});

const HarEntrySchema = z.object({
  startedDateTime: z.string(),
  time: z.number(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    httpVersion: z.string().optional(),
    headers: z.array(HarHeaderSchema),
    queryString: z.array(HarHeaderSchema).optional(),
    cookies: z.array(HarHeaderSchema).optional(),
    headersSize: z.number().optional(),
    bodySize: z.number().optional(),
    postData: HarPostDataSchema.optional(),
  }),
  response: z.object({
    status: z.number(),
    statusText: z.string().optional(),
    httpVersion: z.string().optional(),
    headers: z.array(HarHeaderSchema),
    cookies: z.array(HarHeaderSchema).optional(),
    headersSize: z.number().optional(),
    bodySize: z.number().optional(),
    redirectURL: z.string().optional(),
    content: HarContentSchema,
  }),
  cache: z.record(z.unknown()).optional(),
  timings: z.record(z.number()).optional(),
});

export const BundleSchema = z.object({
  schemaVersion: z.literal("1"),
  intent: z.string().min(1).max(2000),
  narrative: z.string().max(50_000).optional(),
  har: z.object({
    log: z.object({
      version: z.literal("1.2"),
      creator: z.object({ name: z.string(), version: z.string() }),
      browser: z.object({ name: z.string(), version: z.string() }).optional(),
      pages: z.array(z.unknown()).optional(),
      entries: z.array(HarEntrySchema),
    }),
  }),
  audio: z
    .object({
      mimeType: z.string(),
      base64: z.string(),
      durationMs: z.number(),
    })
    .nullable(),
  metadata: z.object({
    capturedBy: z.literal("specialist-extension"),
    extensionVersion: z.string(),
    browser: z.string(),
    capturedAt: z.string(),
    tabUrl: z.string().optional(),
  }),
});

export type Bundle = z.infer<typeof BundleSchema>;
