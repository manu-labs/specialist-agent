// Shared types for the specialist agent.
//
// HTTP traces are the source of truth for everything the agent learns.
// Skills are derived from traces, stored on disk, and version-controlled in git.

export interface HttpTrace {
  id: string;
  startedAt: string;
  endedAt: string;
  intent: string;
  requests: HttpExchange[];
}

export interface HttpExchange {
  index: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    timestamp: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
  };
}

export type SkillKind = "wrapper" | "workflow";

export interface SkillMetadata {
  name: string;
  description: string;
  kind: SkillKind;
  vendor?: string;
  createdAt: string;
  updatedAt: string;
  validatedAt?: string;
  source: "synthesis" | "user-instruction" | "reactive-fix" | "additive-learning";
}

export interface WrapperParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required: boolean;
}

export interface WrapperSpec {
  name: string;
  vendor: string;
  description: string;
  whenToUse: string;
  http: {
    method: string;
    urlTemplate: string;
    contentType: string;
  };
  parameters: WrapperParameter[];
  returns: string;
}

export interface WorkflowSpec {
  name: string;
  description: string;
  whenToUse: string;
  steps: string[];
  inputs: WrapperParameter[];
}

export interface SynthesisResult {
  workflow: WorkflowSpec;
  wrappers: Array<{
    spec: WrapperSpec;
    /** TypeScript function source body (the part inside the function — no signature). */
    implementation: string;
  }>;
}

export interface TenantConfig {
  id: string;
  /** Per-tenant filesystem root: contains the .claude/skills/ tree and services/ libs. */
  workspacePath: string;
  /** API key environment variable name to read from per-call. */
  authEnvVar?: string;
}

export interface CommitContext {
  trigger: SkillMetadata["source"];
  actor: "agent" | "human";
  message: string;
  validation?: {
    replayed: boolean;
    success: boolean;
    notes?: string;
  };
}
