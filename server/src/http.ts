// Shared outbound HTTP with retry/backoff and secret redaction.
// Every third-party call in this codebase goes through here.
const REDACT = /([?&](?:api_key|apikey|token|key)=)[^&\s]+/gi;
export const redact = (s: string) => s.replace(REDACT, "$1***");

export class HttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`HTTP ${status} ${redact(url)}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<Response> {
  const retries = opts.retries ?? 5;
  let delay = opts.baseDelayMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= retries) throw new Error(`network error on ${redact(url)}: ${(e as Error).message}`);
      await sleep(delay); delay *= 2; continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, url, await res.text().catch(() => ""));
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
      delay *= 2; continue;
    }
    if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""));
    return res;
  }
}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithRetry(url, init);
  return res.json() as Promise<T>;
}

// Simple per-adapter rate limiter (n requests per windowMs).
export function rateLimiter(n: number, windowMs: number) {
  let stamps: number[] = [];
  return async () => {
    for (;;) {
      const now = Date.now();
      stamps = stamps.filter(t => now - t < windowMs);
      if (stamps.length < n) { stamps.push(now); return; }
      await sleep(windowMs - (now - stamps[0]) + 5);
    }
  };
}
