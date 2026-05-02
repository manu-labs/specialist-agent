import React from "react";
import type { CaptureStats } from "../../shared/types.js";

interface Props {
  stats: CaptureStats | null;
}

export function StatsPanel({ stats }: Props) {
  if (!stats) {
    return <div className="stats">No requests captured yet.</div>;
  }
  const hosts = Object.entries(stats.byHost).sort((a, b) => b[1].count - a[1].count);
  const seconds = Math.max(1, Math.round(stats.durationMs / 1000));
  return (
    <div className="stats">
      <div>
        {stats.exchangeCount} requests · {formatBytes(stats.totalBytes)} · {seconds}s
      </div>
      {hosts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Host</th>
              <th>Count</th>
              <th>Bytes</th>
            </tr>
          </thead>
          <tbody>
            {hosts.slice(0, 8).map(([host, v]) => (
              <tr key={host}>
                <td>{host}</td>
                <td>{v.count}</td>
                <td>{formatBytes(v.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
