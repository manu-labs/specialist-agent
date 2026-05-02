import React, { useEffect, useState } from "react";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type ExtensionConfig } from "../shared/config.js";

export function Form() {
  const [cfg, setCfg] = useState<ExtensionConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadConfig().then((c) => {
      setCfg(c);
      setLoading(false);
    });
  }, []);

  if (loading) return <p>Loading…</p>;

  const update = <K extends keyof ExtensionConfig>(k: K, v: ExtensionConfig[K]) => {
    setCfg({ ...cfg, [k]: v });
    setSaved(false);
  };

  const onSave = async () => {
    await saveConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <h1>Specialist Capture — Options</h1>
      <p className="help">
        These settings apply to every recording. Bundles are saved to disk by default. To POST
        bundles directly to a synthesis host, fill in the endpoint and bearer token below.
      </p>

      <label>
        POST endpoint (optional)
        <input
          type="text"
          placeholder="https://specialist.acme.internal"
          value={cfg.postEndpoint ?? ""}
          onChange={(e) => update("postEndpoint", e.target.value || null)}
        />
        <span className="help">
          The extension POSTs to <code>{cfg.postEndpoint ?? "<endpoint>"}/v1/bundles</code>.
        </span>
      </label>

      <label>
        Bearer token (optional)
        <input
          type="password"
          value={cfg.postBearerToken ?? ""}
          onChange={(e) => update("postBearerToken", e.target.value || null)}
        />
      </label>

      <label>
        Body byte cap
        <input
          type="number"
          min={1024}
          step={1024}
          value={cfg.bodyMaxBytes}
          onChange={(e) => update("bodyMaxBytes", Number(e.target.value) || DEFAULT_CONFIG.bodyMaxBytes)}
        />
        <span className="help">
          Response bodies larger than this are truncated. Defaults to 1 MiB.
        </span>
      </label>

      <label>
        <input
          type="checkbox"
          checked={cfg.retainAudioByDefault}
          onChange={(e) => update("retainAudioByDefault", e.target.checked)}
        />{" "}
        Include audio blob in bundles by default
      </label>

      <label>
        Host filter mode
        <select
          value={cfg.hostFilterMode}
          onChange={(e) => update("hostFilterMode", e.target.value as ExtensionConfig["hostFilterMode"])}
        >
          <option value="all">Capture all hosts</option>
          <option value="allowlist">Allowlist only</option>
        </select>
      </label>

      {cfg.hostFilterMode === "allowlist" && (
        <label>
          Allowlist (one host per line; <code>*.example.com</code> matches subdomains)
          <textarea
            value={cfg.hostAllowlist.join("\n")}
            onChange={(e) =>
              update(
                "hostAllowlist",
                e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
              )
            }
          />
        </label>
      )}

      <label>
        Transcription engine
        <select
          value={cfg.transcriber}
          onChange={(e) => update("transcriber", e.target.value as ExtensionConfig["transcriber"])}
        >
          <option value="webspeech">Web Speech API (Chrome — sends audio to Google)</option>
          <option value="whisper-wasm">Whisper.wasm (offline; ~30 MB lazy download)</option>
        </select>
      </label>

      <button onClick={onSave}>Save</button>
      {saved && <span className="saved">saved.</span>}
    </>
  );
}
