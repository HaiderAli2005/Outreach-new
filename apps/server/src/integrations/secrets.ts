import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env, isTest } from "../config/env.js";
import { decrypt, encrypt } from "../lib/crypto.js";

/**
 * Mailbox passwords, kept out of Postgres. Rows hold a `credential_ref`; this store holds the secret behind it.
 * Values are never logged and never returned by any API.
 */
export interface SecretStore {
  readonly kind: string;
  get(ref: string): Promise<string | null>;
  put(ref: string, value: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  private map = new Map<string, string>();
  async get(ref: string) {
    return this.map.get(ref) ?? null;
  }
  async put(ref: string, value: string) {
    this.map.set(ref, value);
  }
  async remove(ref: string) {
    this.map.delete(ref);
  }
}

/** Local development: one JSON file, every value encrypted with ENCRYPTION_KEY (AES-256-GCM). */
export class FileSecretStore implements SecretStore {
  readonly kind = "file";
  private cache: Record<string, string> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private path: string) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    const data = JSON.stringify(this.cache ?? {});
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.writing;
  }

  async get(ref: string) {
    const v = (await this.load())[ref];
    return v ? decrypt(v) : null;
  }
  async put(ref: string, value: string) {
    (await this.load())[ref] = encrypt(value);
    await this.save();
  }
  async remove(ref: string) {
    delete (await this.load())[ref];
    await this.save();
  }
}

/** Production: Google Secret Manager, authenticated as the API's own service account through the metadata server. */
export class GcpSecretStore implements SecretStore {
  readonly kind = "gcp";
  private token: { value: string; until: number } | null = null;
  constructor(private project: string) {}

  private id(ref: string) {
    return `aperture-${ref.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 255);
  }

  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) throw new Error(`Secret Manager: no service account token (${r.status})`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return j.access_token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.auth()}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }

  async get(ref: string) {
    const r = await this.call(`/${this.id(ref)}/versions/latest:access`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Secret Manager read failed (${r.status})`);
    const j = (await r.json()) as { payload?: { data?: string } };
    return j.payload?.data ? Buffer.from(j.payload.data, "base64").toString("utf8") : null;
  }
  async put(ref: string, value: string) {
    const created = await this.call(`?secretId=${this.id(ref)}`, { method: "POST", body: JSON.stringify({ replication: { automatic: {} } }) });
    if (!created.ok && created.status !== 409) throw new Error(`Secret Manager create failed (${created.status})`);
    const r = await this.call(`/${this.id(ref)}:addVersion`, { method: "POST", body: JSON.stringify({ payload: { data: Buffer.from(value, "utf8").toString("base64") } }) });
    if (!r.ok) throw new Error(`Secret Manager write failed (${r.status})`);
  }
  async remove(ref: string) {
    const r = await this.call(`/${this.id(ref)}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(`Secret Manager delete failed (${r.status})`);
  }
}

let store: SecretStore | null = null;

export function secretStore(): SecretStore {
  if (store) return store;
  const kind = env.SECRET_STORE ?? (isTest ? "memory" : "file");
  if (kind === "gcp") {
    if (!env.GCP_PROJECT_ID) throw new Error("SECRET_STORE=gcp needs GCP_PROJECT_ID");
    store = new GcpSecretStore(env.GCP_PROJECT_ID);
  } else store = kind === "memory" ? new MemorySecretStore() : new FileSecretStore(env.SECRETS_FILE);
  return store;
}

export function setSecretStore(s: SecretStore | null): void {
  store = s;
}

/** The key a mailbox's password is stored under. */
export const mailboxCredentialRef = (mailboxId: string) => `mailbox:${mailboxId}`;
