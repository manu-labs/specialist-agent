// Public surface of the specialist-agent package.

export { SpecialistAgent } from "./agent.js";
export type { SpecialistAgentOptions } from "./agent.js";

export { TenantWorkspace } from "./tenant/workspace.js";
export { SkillRegistry } from "./skills/registry.js";
export { createMetaSkillServer } from "./skills/meta.js";
export { SafeFs, ScopeViolationError } from "./skills/safe-fs.js";

export { AuthBroker } from "./auth/broker.js";
export type { AuthCredential, AuthProvider, AuthScheme } from "./auth/broker.js";
export { ApiKeyProvider, OAuthProvider, SdkEmbeddedProvider } from "./auth/providers.js";

export { runWrapper, setDefaultBroker, getDefaultBroker, WrapperHttpError } from "./execution/runner.js";
export { replayWrapper } from "./execution/replay.js";

export { startCapture } from "./capture/buffer.js";
export type { CaptureSession } from "./capture/buffer.js";
export { attachFetchInterceptor } from "./capture/interceptor.js";
export { importHar } from "./capture/har.js";
export { scrubBody, scrubHeaders } from "./capture/scrub.js";

export { synthesizeFromTrace } from "./synthesis/synthesize.js";

export type {
  CommitContext,
  HttpExchange,
  HttpTrace,
  SkillKind,
  SkillMetadata,
  SynthesisResult,
  TenantConfig,
  WorkflowSpec,
  WrapperParameter,
  WrapperSpec,
} from "./types.js";
