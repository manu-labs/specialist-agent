export interface ExtensionConfig {
  postEndpoint: string | null;
  postBearerToken: string | null;
  retainAudioByDefault: boolean;
  bodyMaxBytes: number;
  hostFilterMode: "all" | "allowlist";
  hostAllowlist: string[];
  transcriber: "webspeech" | "whisper-wasm";
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  postEndpoint: null,
  postBearerToken: null,
  retainAudioByDefault: false,
  bodyMaxBytes: 1_048_576,
  hostFilterMode: "all",
  hostAllowlist: [],
  transcriber: "webspeech",
};

const CONFIG_KEY = "specialist.config";

export async function loadConfig(): Promise<ExtensionConfig> {
  const raw = await chrome.storage.sync.get(CONFIG_KEY);
  const stored = raw[CONFIG_KEY] as Partial<ExtensionConfig> | undefined;
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

export async function saveConfig(cfg: ExtensionConfig): Promise<void> {
  await chrome.storage.sync.set({ [CONFIG_KEY]: cfg });
}
