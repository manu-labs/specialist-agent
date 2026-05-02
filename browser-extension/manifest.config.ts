import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Specialist Capture",
  version: pkg.version,
  description:
    "Capture HTTP workflows for specialist-agent. Records network exchanges via the Chrome DevTools Protocol and bundles them into a portable JSON file (or POSTs to your synthesis host).",
  background: {
    service_worker: "src/background/main.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Specialist Capture",
  },
  options_page: "src/options/index.html",
  permissions: [
    "debugger",
    "storage",
    "downloads",
    "scripting",
    "offscreen",
    "tabs",
  ],
  host_permissions: ["<all_urls>"],
  web_accessible_resources: [
    {
      resources: ["vendor/whisper-tiny.wasm", "vendor/whisper.js", "src/content/banner.css"],
      matches: ["<all_urls>"],
    },
  ],
});
