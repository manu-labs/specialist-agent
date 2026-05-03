// Save the bundle to disk via chrome.downloads. The user is prompted for
// a save location (saveAs: true) so the file lands somewhere they can
// pipe into `specialist-agent learn --bundle=...`.

import type { Bundle } from "./schema.js";
import { bundleFilename } from "./build.js";

export interface DownloadResult {
  filename: string;
  bytes: number;
  downloadId: number;
}

export async function submitDownload(bundle: Bundle): Promise<DownloadResult> {
  const json = JSON.stringify(bundle);
  const filename = bundleFilename();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
    });
    return { filename, bytes: blob.size, downloadId };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
