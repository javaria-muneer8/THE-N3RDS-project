/**
 * Where the speed test measures against.
 *  - campus:   this app's own server → isolates the Wi-Fi/LAN link (the brief's "campus Wi-Fi monitoring").
 *  - internet: Cloudflare's public speed-test endpoints (the same ones speed.cloudflare.com uses) → comparable
 *              with speedtest.net / fast.com, because traffic leaves the campus and crosses the internet.
 */
export type TargetId = 'campus' | 'internet';

export interface Target {
  id: TargetId;
  label: string;
  pingUrl: () => string;
  downloadUrl: (bytes: number) => string;
  uploadUrl: () => string;
  credentials: RequestCredentials;
  /** extra XHR headers for upload; must stay empty for cross-origin targets to avoid CORS preflight */
  uploadHeaders: Record<string, string>;
  uploadTransport: 'xhr' | 'fetch';
  uploadChunk: number;
  downloadBytes: number;
}

const rnd = () => Math.random().toString(36).slice(2);

export const TARGETS: Record<TargetId, Target> = {
  campus: {
    id: 'campus',
    label: 'Campus server',
    pingUrl: () => `/api/speedtest/ping?t=${rnd()}`,
    downloadUrl: (b) => `/api/speedtest/download?bytes=${b}&t=${rnd()}`,
    uploadUrl: () => `/api/speedtest/upload?t=${rnd()}`,
    credentials: 'include',
    uploadHeaders: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'campus-wifi' },
    uploadTransport: 'xhr',
    uploadChunk: 2 * 1024 * 1024,
    downloadBytes: 8 * 1024 * 1024,
  },
  internet: {
    id: 'internet',
    label: 'Internet (Cloudflare)',
    pingUrl: () => `https://speed.cloudflare.com/__down?bytes=0&r=${rnd()}`,
    downloadUrl: (b) => `https://speed.cloudflare.com/__down?bytes=${b}&r=${rnd()}`,
    uploadUrl: () => `https://speed.cloudflare.com/__up?r=${rnd()}`,
    credentials: 'omit',
    uploadHeaders: {},
    uploadTransport: 'fetch',
    uploadChunk: 1_000_000,
    downloadBytes: 25_000_000,
  },
};

export const isLoopbackHost = (h = window.location.hostname) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
