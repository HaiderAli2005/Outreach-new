export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const attempts = Math.max(1, opts.retries ?? 3);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(u, {
        method: opts.method ?? "GET",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!res.ok) {
        const msg = typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : `HTTP ${res.status}`;
        const err = new HttpError(res.status, msg, data);
        if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
          lastErr = err;
          await sleep(1500 * attempt);
          continue;
        }
        throw err;
      }
      return data as T;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt < attempts) await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
