import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Debounced lookups and chained mocked requests can pass 1s when the whole suite runs in parallel.
configure({ asyncUtilTimeout: 4000 });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const BaseRequest = globalThis.Request;
globalThis.Request = class extends BaseRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" && input.startsWith("/") ? new URL(input, window.location.origin) : input, init);
  }
} as typeof Request;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
