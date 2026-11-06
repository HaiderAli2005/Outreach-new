import type { InboxKitSettings, Prisma } from "@prisma/client";
import { isUniqueViolation, prisma } from "../../../lib/prisma.js";
import { AppError, badRequest, notConfigured, upstream } from "../../../lib/errors.js";
import { env } from "../../../config/env.js";
import { secretStore } from "../../../integrations/secrets.js";
import { account, InboxKitError, type Account, listWorkspaces, setWorkspaceWebhook, warmupPrice, webhookSignature, type Contact, type InboxKitCtx } from "../../../integrations/inboxkit.js";
import { logSystem } from "../../systemLog.js";

/**
 * InboxKit setup for Admin > Domains: the API key (secret store, or INBOXKIT_API_KEY), the workspace orders go into,
 * the registrant contact InboxKit registers every domain with, where a new domain forwards in a browser, and the
 * warmup rules. Nothing here spends money.
 */

export const INBOXKIT_KEY_REF = "inboxkit:api-key";
export const SUPPLIER = "inboxkit";
/** The provider value on a mailbox Aperture ordered through InboxKit. It signs in with InboxKit's app password. */
export const INBOXKIT_PROVIDER = "inboxkit";

const TTL_MS = 60_000;
let keyCache: { at: number; key: string | null; source: "store" | "env" | null } | null = null;
let settingsCache: { at: number; row: InboxKitSettings } | null = null;

export function clearInboxKitCaches(): void {
  keyCache = null;
  settingsCache = null;
}

/** The saved key wins over the environment, so an operator can rotate it without a deploy. */
export async function inboxKitKey(): Promise<{ key: string | null; source: "store" | "env" | null }> {
  if (keyCache && Date.now() - keyCache.at < TTL_MS) return keyCache;
  const stored = await secretStore().get(INBOXKIT_KEY_REF);
  const key = stored?.trim() || env.INBOXKIT_API_KEY?.trim() || null;
  keyCache = { at: Date.now(), key, source: stored?.trim() ? "store" : key ? "env" : null };
  return keyCache;
}

export async function inboxKitSettings(): Promise<InboxKitSettings> {
  if (settingsCache && Date.now() - settingsCache.at < TTL_MS) return settingsCache.row;
  const row = await prisma.inboxKitSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} }).catch((e) => {
    if (isUniqueViolation(e)) return prisma.inboxKitSettings.findUniqueOrThrow({ where: { id: "default" } });
    throw e;
  });
  settingsCache = { at: Date.now(), row };
  return row;
}

/** The key and workspace every call needs. Throws a plain 503 when InboxKit isn't set up. */
export async function inboxKitCtx(opts: { workspace?: boolean } = { workspace: true }): Promise<InboxKitCtx> {
  const { key } = await inboxKitKey();
  if (!key) throw notConfigured("InboxKit (paste the API key in Admin > Domains > InboxKit)");
  const s = await inboxKitSettings();
  if (opts.workspace !== false && !s.workspaceUid) throw notConfigured("The InboxKit workspace (choose it in Admin > Domains > InboxKit)");
  return { key, workspace: s.workspaceUid };
}

/** InboxKit's published prices (inboxkit.com/pricing, Oct 2026), used only when the account doesn't report its own. */
export const LIST_PRICE = { mailboxMonthUsd: 3, warmupMonthUsd: 3 } as const;

/**
 * What one mailbox and its warmup cost a month: the account's own prices when InboxKit reports them, otherwise the
 * published price, marked as an estimate so the screen says so. Never 0 by accident.
 */
export function unitPrices(platform: string, a: Pick<Account, "costPerGoogleMailbox" | "costPerMicrosoftMailbox"> | null, warmup: number | null) {
  const reported = platform === "MICROSOFT" ? a?.costPerMicrosoftMailbox : a?.costPerGoogleMailbox;
  const box = reported && reported > 0 ? reported : null;
  const warm = warmup && warmup > 0 ? warmup : null;
  return { mailboxMonthUsd: box ?? LIST_PRICE.mailboxMonthUsd, warmupMonthUsd: warm ?? LIST_PRICE.warmupMonthUsd, estimated: box === null || warm === null };
}

/** Where InboxKit should send status webhooks: the public API address. */
export const webhookUrl = () => `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/inboxkit/webhook`;

const CONTACT_FIELDS = ["first_name", "last_name", "email", "phone", "address_line1", "city", "state", "country", "postal_code"] as const;

/** The registrant contact, or the fields still missing (InboxKit refuses an order without every one of them). */
export function contactOf(s: Pick<InboxKitSettings, "contact">): { contact: Contact | null; missing: string[] } {
  const c = (s.contact ?? {}) as Record<string, unknown>;
  const missing = CONTACT_FIELDS.filter((f) => typeof c[f] !== "string" || !(c[f] as string).trim());
  return missing.length ? { contact: null, missing: [...missing] } : { contact: c as unknown as Contact, missing: [] };
}

/** What still stops "Add new domains" from working, in the order an operator fixes it. Empty = ready. */
export function blockers(s: InboxKitSettings, keySet: boolean): string[] {
  const out: string[] = [];
  if (!keySet) out.push("Paste your InboxKit API key (InboxKit, Settings > API).");
  if (!s.workspaceUid) out.push("Choose the InboxKit workspace new domains go into.");
  const { missing } = contactOf(s);
  if (missing.length) out.push(`Fill in the registrant contact InboxKit registers domains with (missing: ${missing.map((m) => m.replace(/_/g, " ")).join(", ")}).`);
  if (!s.redirectUrl) out.push("Set where a new domain forwards when someone opens it in a browser (for example your company website).");
  return out;
}

const view = (s: InboxKitSettings) => ({
  workspaceUid: s.workspaceUid,
  workspaceName: s.workspaceName,
  contact: (s.contact ?? null) as Partial<Contact> | null,
  redirectUrl: s.redirectUrl,
  platform: s.platform as "GOOGLE" | "MICROSOFT",
  warmupDays: s.warmupDays,
  keepWarmupAfterLive: s.keepWarmupAfterLive,
  maxDomainPriceUsd: Number(s.maxDomainPriceUsd),
});

/**
 * Admin > Domains > InboxKit. Reads the account live when a key is set, so a wrong key or an empty wallet shows here
 * before anyone tries to order. The key itself is never returned.
 */
export async function inboxKitStatus() {
  const [{ key, source }, s] = await Promise.all([inboxKitKey(), inboxKitSettings()]);
  let wallet: number | null = null;
  let acct: Account | null = null;
  let warmupPerMailbox: number | null = null;
  let workspaces: { uid: string; name: string }[] = [];
  let error: string | null = null;
  if (key) {
    try {
      const ctx: InboxKitCtx = { key, workspace: s.workspaceUid };
      const [a, ws] = await Promise.all([account(ctx), listWorkspaces(ctx)]);
      wallet = a.creditsRemaining;
      acct = a;
      workspaces = ws.map((w) => ({ uid: w.uid, name: w.name }));
      if (s.workspaceUid) warmupPerMailbox = await warmupPrice(ctx).catch(() => null);
    } catch (e) {
      error = e instanceof InboxKitError && e.status === 401 ? "InboxKit refused this API key. Paste a current one." : `Couldn't reach InboxKit: ${(e as Error).message}`;
    }
  }
  return {
    key: { set: !!key, source },
    connected: !!key && !error,
    error,
    wallet,
    prices: unitPrices(s.platform, acct, warmupPerMailbox),
    workspaces,
    settings: view(s),
    webhook: { url: webhookUrl(), signature: "InboxKit signs with sha256 of your API key; Aperture checks it and then reads the state back from the API." },
    blockers: blockers(s, !!key),
  };
}

/**
 * Domains or orders Aperture is still following at InboxKit. While there are any, the workspace can't change and a new
 * key must reach the same workspace: otherwise they would stop syncing, retired ones would keep billing, and an order
 * with no answer yet could never be matched.
 */
async function inUse(): Promise<boolean> {
  const [domains, orders] = await Promise.all([
    prisma.sendingDomain.count({ where: { supplier: SUPPLIER, status: { not: "RETIRED" } } }),
    prisma.supplierOrder.count({ where: { OR: [{ status: { in: ["SCHEDULED", "WAITING_FOR_FUNDS"] } }, { items: { some: { status: "PLACING" } } }] } }),
  ]);
  const toCancel = await prisma.mailbox.count({ where: { provider: INBOXKIT_PROVIDER, status: "RETIRED", supplierCancelRequestedAt: null } });
  return domains + orders + toCancel > 0;
}

/** Checks a pasted key against InboxKit before keeping it. */
export async function saveInboxKitKey(raw: string, operatorId: string) {
  const key = raw.trim();
  if (key.length < 16 || /\s/.test(key)) throw badRequest("That doesn't look like an InboxKit API key. Copy it again from InboxKit, Settings > API.");
  try {
    const ws = await listWorkspaces({ key });
    const s = await inboxKitSettings();
    if (s.workspaceUid && !ws.some((w) => w.uid === s.workspaceUid) && (await inUse())) {
      throw badRequest(`This key can't reach the workspace ${s.workspaceName ?? s.workspaceUid}, where Aperture's InboxKit domains are. Use a key from the same InboxKit account.`);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof InboxKitError && e.status === 401) throw badRequest("InboxKit refused this API key. Copy it again from InboxKit, Settings > API.");
    throw upstream("InboxKit", (e as Error).message);
  }
  await secretStore().put(INBOXKIT_KEY_REF, key);
  clearInboxKitCaches();
  await logSystem(null, "INFO", "pool", "InboxKit API key saved by an operator.", { operatorId });
  return inboxKitStatus();
}

export interface InboxKitSettingsPatch {
  workspaceUid?: string;
  contact?: Partial<Contact>;
  redirectUrl?: string;
  platform?: "GOOGLE" | "MICROSOFT";
  warmupDays?: number;
  keepWarmupAfterLive?: boolean;
  maxDomainPriceUsd?: number;
}

/**
 * Saves the settings. Choosing a workspace also points that workspace's InboxKit webhooks at Aperture, so setup and
 * suspensions show within minutes instead of at the next scheduled read (the read still runs either way).
 */
export async function updateInboxKitSettings(patch: InboxKitSettingsPatch, operatorId: string) {
  const s = await inboxKitSettings();
  const data: Prisma.InboxKitSettingsUpdateInput = { updatedById: operatorId };
  if (patch.workspaceUid !== undefined && patch.workspaceUid !== s.workspaceUid) {
    if (s.workspaceUid && (await inUse())) throw badRequest("Aperture is still following domains or an order in the current InboxKit workspace, so it can't change. Retire those domains (and let their cancellation go through) first.");
    const ctx = await inboxKitCtx({ workspace: false });
    const ws = (await listWorkspaces(ctx)).find((w) => w.uid === patch.workspaceUid);
    if (!ws) throw badRequest("That workspace isn't in this InboxKit account");
    data.workspaceUid = ws.uid;
    data.workspaceName = ws.name;
    await setWorkspaceWebhook(ctx, ws.uid, webhookUrl()).catch((e: Error) => logSystem(null, "WARN", "pool", `InboxKit webhook not set for workspace ${ws.name}: ${e.message}. Status still syncs every 10 minutes.`));
  }
  if (patch.contact) data.contact = { ...((s.contact ?? {}) as Record<string, string>), ...patch.contact } as Prisma.InputJsonValue;
  if (patch.redirectUrl !== undefined) data.redirectUrl = patch.redirectUrl;
  if (patch.platform) data.platform = patch.platform;
  if (patch.warmupDays !== undefined) data.warmupDays = patch.warmupDays;
  if (patch.keepWarmupAfterLive !== undefined) data.keepWarmupAfterLive = patch.keepWarmupAfterLive;
  if (patch.maxDomainPriceUsd !== undefined) data.maxDomainPriceUsd = patch.maxDomainPriceUsd.toFixed(2);
  await prisma.inboxKitSettings.update({ where: { id: "default" }, data });
  clearInboxKitCaches();
  await logSystem(null, "INFO", "pool", "InboxKit settings changed by an operator.", { operatorId, fields: Object.keys(patch) });
  return inboxKitStatus();
}

/** For the webhook route: true when the header carries InboxKit's signature for the current key. */
export async function expectedSignature(): Promise<string | null> {
  const { key } = await inboxKitKey();
  return key ? webhookSignature(key) : null;
}
