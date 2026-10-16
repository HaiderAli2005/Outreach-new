import Bottleneck from "bottleneck";
import { fetchJson } from "./http.js";
import { getCredential } from "./credentials.js";

const limiter = new Bottleneck({ maxConcurrent: 3, minTime: 100 });
const SENDABLE = new Set(["ok", "catch_all"]);
const BAD = new Set(["invalid", "disposable"]);
const CREDIT_ERROR = /credit|quota|insufficient|balance|limit reached|out of/i;

export interface VerifyResult {
  configured: boolean;
  ok: boolean;
  bad: boolean;
  transient: boolean;
  result: string;
  quality: string | null;
  noCredits?: boolean;
}

export type Verifier = (email: string) => Promise<VerifyResult>;

async function millionVerifier(key: string, email: string): Promise<VerifyResult> {
  if (!email.includes("@")) return { configured: true, ok: false, bad: true, transient: false, result: "invalid", quality: "bad" };
  try {
    const d = await limiter.schedule(() =>
      fetchJson<Record<string, unknown>>("https://api.millionverifier.com/api/v3/", { query: { api: key, email, timeout: 10 }, timeoutMs: 15_000, retries: 2 }),
    );
    if (d.error) {
      const noCredits = CREDIT_ERROR.test(String(d.error));
      return { configured: true, ok: true, bad: false, transient: true, result: noCredits ? "no_credits" : "error", quality: null, noCredits };
    }
    const result = String(d.result ?? "unknown").toLowerCase();
    const quality = d.quality ? String(d.quality).toLowerCase() : null;
    return { configured: true, ok: SENDABLE.has(result) && quality !== "bad", bad: BAD.has(result) || quality === "bad", transient: false, result, quality };
  } catch {
    return { configured: true, ok: true, bad: false, transient: true, result: "error", quality: null };
  }
}

type Factory = (orgId: string) => Promise<Verifier | null>;
const defaultFactory: Factory = async (orgId) => {
  const key = await getCredential(orgId, "MILLIONVERIFIER");
  return key ? (email: string) => millionVerifier(key, email) : null;
};
let factory: Factory = defaultFactory;

export function verifierFor(orgId: string): Promise<Verifier | null> {
  return factory(orgId);
}

export function setVerifierFactory(f: Factory | null): void {
  factory = f ?? defaultFactory;
}
