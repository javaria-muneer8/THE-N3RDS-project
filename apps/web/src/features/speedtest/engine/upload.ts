import type { ThroughputResult } from './download';

let payload: Uint8Array | null = null;
function randomPayload(size: number): Uint8Array {
  if (payload && payload.length === size) return payload;
  const p = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(p.subarray(i, Math.min(size, i + 65536)));
  payload = p;
  return p;
}

/** Phase 3: parallel XHR uploads of incompressible data; progress events give live throughput. */
export async function runUpload(opts: {
  url?: () => string;
  withCredentials?: boolean;
  headers?: Record<string, string>;
  /** 'xhr' gives byte-level progress (same-origin); 'fetch' avoids CORS preflights for public servers */
  transport?: 'xhr' | 'fetch';
  workers?: number;
  chunkBytes?: number;
  durationMs?: number;
  warmupMs?: number;
  signal?: AbortSignal;
  onProgress?: (mbps: number, fraction: number) => void;
}): Promise<ThroughputResult> {
  const { workers = 3, chunkBytes = 2 * 1024 * 1024, durationMs = 6000, warmupMs = 1000, signal } = opts;
  const body = randomPayload(chunkBytes);
  const start = performance.now();
  let windowStart = 0;
  let measured = 0;
  let total = 0;
  let done = false;
  let failure: unknown = null;
  const xhrs = new Set<XMLHttpRequest>();

  const tick = setInterval(() => {
    const now = performance.now();
    if (now - start >= warmupMs && windowStart === 0) {
      windowStart = now;
      measured = 0;
    }
    const secs = windowStart ? (now - windowStart) / 1000 : (now - start) / 1000;
    const bytes = windowStart ? measured : total;
    if (secs > 0.05) opts.onProgress?.((bytes * 8) / secs / 1e6, Math.min(1, (now - start) / durationMs));
  }, 150);

  const one = () =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrs.add(xhr);
      let last = 0;
      xhr.upload.onprogress = (e) => {
        const d = e.loaded - last;
        last = e.loaded;
        total += d;
        if (windowStart) measured += d;
      };
      xhr.onload = () => (xhrs.delete(xhr), xhr.status < 400 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
      xhr.onerror = () => (xhrs.delete(xhr), reject(new Error('Network error')));
      xhr.onabort = () => (xhrs.delete(xhr), resolve());
      xhr.open('POST', opts.url ? opts.url() : `/api/speedtest/upload?t=${Math.random()}`);
      xhr.withCredentials = opts.withCredentials ?? true;
      const headers = opts.headers ?? { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'campus-wifi' };
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.send(body as unknown as Blob);
    });

  // Cross-origin variant: simple POST requests (no custom headers, no upload listeners → no preflight).
  const controllers = new Set<AbortController>();
  const oneFetch = async () => {
    const ac = new AbortController();
    controllers.add(ac);
    try {
      const res = await fetch(opts.url ? opts.url() : '/api/speedtest/upload', { method: 'POST', body: body as unknown as BodyInit, cache: 'no-store', credentials: 'omit', signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      total += body.length;
      if (windowStart) measured += body.length;
    } catch (e) {
      if (!done) throw e;
    } finally {
      controllers.delete(ac);
    }
  };
  const worker = async () => {
    while (!done) await (opts.transport === 'fetch' ? oneFetch() : one());
  };
  const abortAll = () => {
    xhrs.forEach((x) => x.abort());
    controllers.forEach((c) => c.abort());
  };
  signal?.addEventListener('abort', abortAll, { once: true });
  const runners = Array.from({ length: workers }, () => worker().catch((e) => { if (!done) failure = e; }));
  await Promise.race([new Promise((r) => setTimeout(r, durationMs)), Promise.all(runners)]);
  done = true;
  const end = performance.now();
  abortAll();
  clearInterval(tick);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const secs = windowStart ? (end - windowStart) / 1000 : 0;
  if (failure && measured === 0) throw failure;
  if (secs <= 0 || measured === 0) throw new Error('No data sent');
  return { mbps: (measured * 8) / secs / 1e6, bytes: measured, seconds: secs };
}
