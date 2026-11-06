import { createHash, timingSafeEqual } from "node:crypto";
import { fetchJson, HttpError } from "./http.js";

/**
 * InboxKit's REST API (https://docs.inboxkit.com), the part Aperture uses to order domains with mailboxes on them,
 * read their setup and warmup, and cancel them once they retire.
 *
 *   Authorization: Bearer <API key>        every call
 *   X-Workspace-Id: <workspace uid>        every workspace call (orders, domains, mailboxes, warmup)
 *
 * Nothing here knows about Aperture's database: callers pass the key and workspace (domain/pool/inboxkit/settings.ts).
 * Credentials that come back (mailbox passwords) are returned to the caller only, never logged.
 *
 * Retries: reads retry on 429 and 5xx. A call that spends money (placing an order) never retries by itself: a timeout
 * there is "unknown", and the sync adopts the domain if it shows up at InboxKit (see placeOrder).
 */

export const INBOXKIT_API = "https://api.inboxkit.com/v1/api";

export interface InboxKitCtx {
  key: string;
  workspace?: string | null;
}

export class InboxKitError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "InboxKitError";
  }
}

/** InboxKit answers errors in three shapes: {message}, {code, message} and [{status: "error", message}]. */
export function errorText(body: unknown, status: number): string {
  const first = Array.isArray(body) ? body[0] : body;
  if (first && typeof first === "object" && "message" in first && typeof (first as { message: unknown }).message === "string") return (first as { message: string }).message;
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  if (status === 401) return "InboxKit refused the API key";
  return `InboxKit answered HTTP ${status}`;
}

interface CallOpts {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sends X-Workspace-Id. Throws when the workspace isn't chosen yet. */
  workspace?: boolean;
  /** Retries on 429/5xx/network. Off for anything that spends money. */
  retry?: boolean;
  timeoutMs?: number;
}

async function call<T>(ctx: InboxKitCtx, path: string, opts: CallOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.key}` };
  if (opts.workspace) {
    if (!ctx.workspace) throw new InboxKitError(400, "Choose the InboxKit workspace first (Admin > Domains > InboxKit)");
    headers["X-Workspace-Id"] = ctx.workspace;
  }
  try {
    return await fetchJson<T>(`${INBOXKIT_API}${path}`, { method: opts.method ?? "GET", headers, body: opts.body, query: opts.query, retries: opts.retry === false ? 1 : 3, timeoutMs: opts.timeoutMs ?? 30_000 });
  } catch (e) {
    if (e instanceof HttpError) throw new InboxKitError(e.status, errorText(e.body, e.status), e.body);
    throw e;
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

// ─── Account and workspaces ─────────────────────────────────────────────────────────────────────────────────────

export interface Workspace {
  uid: string;
  name: string;
  domains: number | null;
}

export async function listWorkspaces(ctx: InboxKitCtx): Promise<Workspace[]> {
  const r = await call<{ workspaces?: Record<string, unknown>[] }>(ctx, "/workspaces/list");
  return (r.workspaces ?? []).map((w) => ({ uid: String(w.uid), name: str(w.name) ?? String(w.uid), domains: num(w.domains) }));
}

export interface Account {
  team: string | null;
  adminEmail: string | null;
  /** Wallet balance in USD (InboxKit credits are dollars: an order's total_cost is compared with available_credits). */
  creditsRemaining: number | null;
  costPerGoogleMailbox: number | null;
  costPerMicrosoftMailbox: number | null;
}

export async function account(ctx: InboxKitCtx): Promise<Account> {
  const r = await call<Record<string, unknown>>(ctx, "/account");
  return {
    team: str(r.team),
    adminEmail: str(r.admin_email),
    creditsRemaining: num(r.credits_remaining),
    costPerGoogleMailbox: num(r.cost_per_google_mailbox),
    costPerMicrosoftMailbox: num(r.cost_per_ms_outlook_mailbox),
  };
}

/** Points InboxKit's status webhooks for a workspace at Aperture. */
export async function setWorkspaceWebhook(ctx: InboxKitCtx, workspaceUid: string, url: string): Promise<void> {
  await call(ctx, "/workspaces/webhook", { method: "POST", body: { uid: workspaceUid, webhook_url: url } });
}

// ─── Domains ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Availability {
  available: boolean;
  banned: boolean;
  registrationPrice: number | null;
  renewalPrice: number | null;
}

/** One exact name: free to register, not on InboxKit's banned list, and its price. Rate limited to 50 a minute. */
export async function domainAvailable(ctx: InboxKitCtx, domain: string): Promise<Availability> {
  const r = await call<Record<string, unknown>>(ctx, "/domains/available", { query: { domain } });
  return { available: r.available === true, banned: r.banned === true, registrationPrice: num(r.registration_price), renewalPrice: num(r.renewal_price) };
}

export interface IkDomain {
  uid: string;
  name: string;
  status: string;
  nameserverMatch: string | null;
  renewalDate: string | null;
}

/** Every domain in the workspace, all pages. */
export async function listAllDomains(ctx: InboxKitCtx, opts: { keywords?: string; maxPages?: number } = {}): Promise<IkDomain[]> {
  const out: IkDomain[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 500); page++) {
    const r = await call<{ domains?: Record<string, unknown>[]; pages?: number }>(ctx, "/domains/list", { method: "POST", workspace: true, body: { page, limit: 100, ...(opts.keywords ? { keywords: opts.keywords } : {}) } });
    for (const d of r.domains ?? []) out.push({ uid: String(d.uid), name: String(d.name).toLowerCase(), status: String(d.status ?? ""), nameserverMatch: str(d.nameserver_match_status), renewalDate: str(d.renewal_date) });
    if (!r.pages || page >= r.pages) break;
  }
  return out;
}

// ─── Mailboxes ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface IkMailbox {
  uid: string;
  email: string;
  domain: string;
  platform: string;
  status: string;
  isAdmin: boolean;
  renewalDate: string | null;
}

/** InboxKit mailbox states that mean it is gone or broken, not still being set up. */
export const MAILBOX_DEAD = ["failed", "suspended", "cancelled", "deleted", "archived", "renewal_failed", "scheduled_for_cancellation", "inactive"] as const;

/** Every mailbox in the workspace, all pages (optionally on one domain). */
export async function listAllMailboxes(ctx: InboxKitCtx, opts: { domain?: string; maxPages?: number } = {}): Promise<IkMailbox[]> {
  const out: IkMailbox[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 1000); page++) {
    const r = await call<{ mailboxes?: Record<string, unknown>[]; pages?: number }>(ctx, "/mailboxes/list", { method: "POST", workspace: true, body: { page, limit: 100, ...(opts.domain ? { domain: opts.domain } : {}) } });
    for (const m of r.mailboxes ?? []) {
      const domain = String(m.domain_name ?? "").toLowerCase();
      const username = String(m.username ?? "").toLowerCase();
      out.push({ uid: String(m.uid), email: `${username}@${domain}`, domain, platform: String(m.platform ?? "GOOGLE"), status: String(m.status ?? ""), isAdmin: m.is_admin === true, renewalDate: str(m.renewal_date) });
    }
    if (!r.pages || page >= r.pages) break;
  }
  return out;
}

/** The sign-in InboxKit issued for an active mailbox. The app password is what SMTP and IMAP use. Never log it. */
export async function mailboxCredentials(ctx: InboxKitCtx, uid: string): Promise<{ password: string | null; appPassword: string | null }> {
  const r = await call<Record<string, unknown>>(ctx, "/mailboxes/show-credentials", { workspace: true, query: { uid } });
  return { password: str(r.password), appPassword: str(r.app_password) };
}

/** Schedules mailboxes for cancellation at InboxKit (they stop renewing). Safe to repeat. */
export async function cancelMailboxes(ctx: InboxKitCtx, uids: string[]): Promise<void> {
  if (!uids.length) return;
  await call(ctx, "/mailboxes/cancel", { method: "POST", workspace: true, body: { uids } });
}

// ─── Orders ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Contact {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  organization?: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
}

export interface OrderDomain {
  name: string;
  redirect_url: string;
  registration_years: number;
  mailboxes: { email: string; first_name: string; last_name: string; platform: "GOOGLE" | "MICROSOFT" }[];
}

export interface OrderItem {
  domain: string;
  queued: boolean;
  orderId: string | null;
  message: string | null;
  /** The name itself was the problem (taken or banned), so another name may well go through. */
  nameProblem: boolean;
}

/** Answers that can arrive after InboxKit already took an order: request timeout, conflict, client closed. */
const AMBIGUOUS = [408, 409, 499];

export type OrderOutcome =
  | { kind: "placed"; items: OrderItem[] }
  | { kind: "refused"; status: number; message: string; items: OrderItem[]; totalCost: number | null; availableCredits: number | null }
  /** No clear answer (timeout, connection dropped, 5xx): the order may or may not exist at InboxKit. */
  | { kind: "unknown"; message: string };

function orderItems(body: unknown): OrderItem[] {
  if (!Array.isArray(body)) return [];
  return body
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => {
      const status = String(x.status ?? "");
      const queued = status !== "error" && /queued/i.test(status);
      return {
        domain: String(x.domain ?? "").toLowerCase(),
        queued,
        orderId: str(x.order_id),
        message: str(x.message),
        nameProblem: !queued && (x.available === false || x.banned === true || /not available|banned|taken|already/i.test(String(x.message ?? ""))),
      };
    });
}

/**
 * Registers each domain, creates its mailboxes and (with warmup on) books InboxKit warmup on every mailbox, paid from
 * the InboxKit wallet. The answer is one item per domain: some can be queued while others are rejected.
 */
export async function placeOrder(ctx: InboxKitCtx, order: { contact: Contact; domains: OrderDomain[]; warmup: boolean }): Promise<OrderOutcome> {
  try {
    const body = await call<unknown>(ctx, "/orders", { method: "POST", workspace: true, retry: false, timeoutMs: 120_000, body: { contact_details: order.contact, domains: order.domains, warmup_addon_enabled: order.warmup } });
    return { kind: "placed", items: orderItems(body) };
  } catch (e) {
    // A 4xx means nothing was bought, except the ones a proxy or a busy InboxKit can send after taking the order.
    if (e instanceof InboxKitError && e.status >= 400 && e.status < 500 && !AMBIGUOUS.includes(e.status)) {
      const first = Array.isArray(e.body) ? (e.body[0] as Record<string, unknown> | undefined) : undefined;
      return { kind: "refused", status: e.status, message: e.message, items: orderItems(e.body), totalCost: num(first?.total_cost), availableCredits: num(first?.available_credits) };
    }
    return { kind: "unknown", message: (e as Error).message };
  }
}

// ─── Warmup ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Warmup {
  uid: string;
  mailboxUid: string | null;
  email: string;
  status: string;
  health: string | null;
  startedAt: string | null;
  score: number | null;
  inboxRate: number | null;
  day: number | null;
}

/** Every warmup subscription in the workspace (active, paused, pending, past due), all pages. */
export async function listWarmups(ctx: InboxKitCtx, opts: { maxPages?: number } = {}): Promise<Warmup[]> {
  const out: Warmup[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 100); page++) {
    const r = await call<{ subscriptions?: Record<string, unknown>[]; pages?: number }>(ctx, "/warmup/list", { method: "POST", workspace: true, body: { page, limit: 100 } });
    for (const s of r.subscriptions ?? []) {
      const stats = (s.cached_stats ?? {}) as Record<string, unknown>;
      const mailbox = (s.mailbox ?? {}) as Record<string, unknown>;
      out.push({
        uid: String(s.uid),
        mailboxUid: str(mailbox.uid),
        email: String(s.mailbox_email ?? "").toLowerCase(),
        status: String(s.status ?? ""),
        health: str(s.health_status),
        startedAt: str(s.started_at),
        score: num(stats.health_score),
        inboxRate: num(stats.inbox_rate),
        day: num(stats.warmup_day),
      });
    }
    if (!r.pages || page >= r.pages) break;
  }
  return out;
}

export async function warmupPrice(ctx: InboxKitCtx): Promise<number | null> {
  const r = await call<Record<string, unknown>>(ctx, "/warmup/pricing", { workspace: true });
  return num(r.price_per_mailbox);
}

/** Books warmup on mailboxes that don't have it (it starts when each mailbox is ready). */
export async function addWarmup(ctx: InboxKitCtx, mailboxUids: string[]): Promise<void> {
  for (let i = 0; i < mailboxUids.length; i += 100) await call(ctx, "/warmup/add", { method: "POST", workspace: true, retry: false, body: { mailbox_uids: mailboxUids.slice(i, i + 100), activate_immediately: false } });
}

export async function cancelWarmup(ctx: InboxKitCtx, mailboxUids: string[]): Promise<void> {
  for (let i = 0; i < mailboxUids.length; i += 100) await call(ctx, "/warmup/cancel", { method: "POST", workspace: true, body: { mailbox_uids: mailboxUids.slice(i, i + 100) } });
}

// ─── Webhooks ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * InboxKit signs a webhook with "sha256=" + hex SHA-256 of the team's API key. The body is not part of it, so the
 * signature only proves the sender knows the key: Aperture never trusts a webhook's contents, it only takes it as a
 * nudge to read the current state back from the API.
 */
export function webhookSignature(key: string): string {
  return `sha256=${createHash("sha256").update(key).digest("hex")}`;
}

export function verifyWebhookSignature(key: string, header: string | undefined): boolean {
  if (!header) return false;
  const want = Buffer.from(webhookSignature(key));
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}
