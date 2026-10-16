import { vi } from "vitest";
import { json } from "./fixtures";

type Handler = (body: unknown, call: number) => Response | Promise<Response>;

export function mockServer(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const counts: Record<string, number> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, window.location.origin);
    const path = url.pathname.replace(/^\/api\/v1/, "") + url.search;
    const text = req.method === "GET" ? "" : await req.text();
    const body = text ? JSON.parse(text) : undefined;
    const key = `${req.method} ${path}`;
    calls.push({ method: req.method, path, body, headers: req.headers });
    counts[key] = (counts[key] ?? 0) + 1;
    const handler = routes[key] ?? routes[`${req.method} ${url.pathname.replace(/^\/api\/v1/, "")}`];
    if (!handler) return json({ error: { code: "NOT_FOUND", message: `No mock for ${key}` } }, 404);
    return handler(body, counts[key]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
