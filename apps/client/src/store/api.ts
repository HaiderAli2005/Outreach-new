import { createApi, fetchBaseQuery, type BaseQueryFn, type FetchArgs, type FetchBaseQueryError } from "@reduxjs/toolkit/query/react";
import { sessionReceived, signedOut, rememberedOrg } from "./authSlice";
import { creditsRefused } from "./upgradeSlice";
import type {
  SiteCheck,
  PoolSettings,
  BusinessProfile,
  SequenceView,
  TargetingView,
  TargetingEdit,
  TargetingImpact,
  AddedPoolDomain,
  NewPoolDomain,
  NewPoolMailbox,
  PoolDomain,
  AutopilotStatus,
  Batch,
  BlockEntry,
  Campaign,
  Catalogue,
  Cockpit,
  CostPrices,
  Performance,
  Company,
  Contact,
  CreditPacing,
  CreditsPanel,
  TopupStart,
  CredentialStatus,
  InboxCounts,
  KeywordCounts,
  InboxRow,
  Member,
  Meta,
  NavCounts,
  OnboardingState,
  OrgSettings,
  BudgetCard,
  TopupOptions,
  VolumeOptions,
  SetupStart,
  PaymentToConfirm,
  Paged,
  Payment,
  Provider,
  Session,
  AuthResult,
  ChallengeState,
  Verification,
  SettingsView,
  SystemLog,
  ThreadMessage,
  Thread,
  FactKey,
  MarketView,
  AdminPoolView,
  AdminUnmatchedInbound,
  AdminUnmatchedCandidate,
  AdminIntentCorrections,
  LaunchView,
  VocabItem,
  OrgKind,
  BalanceView,
} from "@/lib/types";

export const API_BASE = "/api/v1";

interface AuthShape {
  auth: { token: string | null; activeOrgId: string | null };
}

const raw = fetchBaseQuery({
  baseUrl: API_BASE,
  credentials: "include",
  prepareHeaders(headers, { getState }) {
    const { token, activeOrgId } = (getState() as AuthShape).auth;
    if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    if (activeOrgId && !headers.has("x-organization-id")) headers.set("x-organization-id", activeOrgId);
    return headers;
  },
});

let refreshing: Promise<Session | null> | null = null;

export function refreshSession(organizationId?: string | null): Promise<Session | null> {
  if (!refreshing) {
    refreshing = fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-requested-with": "aperture" },
      body: JSON.stringify({ organizationId: organizationId ?? rememberedOrg() }),
    })
      .then(async (r) => (r.ok ? ((await r.json()) as { data: Session }).data : null))
      .catch(() => null)
      .finally(() => {
        setTimeout(() => {
          refreshing = null;
        }, 0);
      });
  }
  return refreshing;
}

const baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (args, api, extra) => {
  let result = await raw(args, api, extra);
  const url = typeof args === "string" ? args : args.url;
  if (result.error?.status === 401 && !url.startsWith("/auth/")) {
    const state = api.getState() as AuthShape;
    const session = await refreshSession(state.auth.activeOrgId);
    if (session) {
      api.dispatch(sessionReceived(session));
      result = await raw(args, api, extra);
    } else {
      api.dispatch(signedOut());
    }
  }
  // The single place that reacts to a refused spend: it opens the one upgrade prompt and refreshes the balance.
  if (result.error?.status === 402 && errorCode(result.error) === "INSUFFICIENT_CREDITS") {
    api.dispatch(creditsRefused((result.error.data as { error?: { message?: string } } | undefined)?.error?.message ?? "You're out of credits."));
    // `api` is defined below; this runs only after the module has loaded.
    api.dispatch(apiSlice().util.invalidateTags(["Credits"]));
  }
  return result;
};

const apiSlice = () => api;

/** Messages already shown by the upgrade prompt; callers that toast errors stay quiet for these. */
const HANDLED_CODES = new Set(["INSUFFICIENT_CREDITS"]);

export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!err || typeof err !== "object") return fallback;
  if (HANDLED_CODES.has(errorCode(err) ?? "")) return "";
  const e = err as { status?: unknown; data?: unknown; error?: string; message?: string };
  const data = e.data as { error?: { message?: string } } | undefined;
  if (data?.error?.message) return data.error.message;
  if (e.status === "FETCH_ERROR") return "Can't reach the server. Check your connection and try again.";
  if (typeof e.message === "string" && e.message) return e.message;
  return fallback;
}

export function errorCode(err: unknown): string | null {
  const data = (err as { data?: { error?: { code?: string } } } | undefined)?.data;
  return data?.error?.code ?? null;
}

const unwrap = <T,>(r: { data: T }) => r.data;
const paged = <T, M = Meta>(r: { data: T; meta?: M }): Paged<T, M> => ({ data: r.data, meta: (r.meta ?? {}) as M });

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export type LaunchResult = { campaignId: string; missing: string[]; state: OnboardingState };

export const api = createApi({
  reducerPath: "api",
  baseQuery,
  tagTypes: ["Launch", "Vocab", "Credits", "Me", "Onboarding", "Cockpit", "Nav", "Inbox", "Thread", "Contacts", "Batches", "Campaigns", "Blocklist", "Settings", "Autopilot", "Metrics", "Mailboxes", "Members", "Org", "Logs", "Billing", "Usage", "Admin"],
  endpoints: (b) => ({
    providers: b.query<{ google: boolean; passwordReset: boolean }, void>({ query: () => "/auth/providers", transformResponse: unwrap }),
    login: b.mutation<AuthResult, { email: string; password: string }>({ query: (body) => ({ url: "/auth/login", method: "POST", body }), transformResponse: unwrap }),
    register: b.mutation<AuthResult, { name: string; email: string; password: string; organizationName?: string; domain?: string }>({
      query: (body) => ({ url: "/auth/register", method: "POST", body }),
      transformResponse: unwrap,
    }),
    challengeStatus: b.query<ChallengeState, string>({
      query: (challengeId) => ({ url: "/auth/challenge/status", method: "POST", body: { challengeId } }),
      transformResponse: unwrap,
      keepUnusedDataFor: 0,
    }),
    challengeCode: b.mutation<{ purpose: "VERIFY"; session: Session } | { purpose: "RESET"; token: string }, { challengeId: string; code: string }>({
      query: (body) => ({ url: "/auth/challenge/code", method: "POST", body }),
      transformResponse: unwrap,
    }),
    challengeSendCode: b.mutation<{ sent: boolean }, string>({
      query: (challengeId) => ({ url: "/auth/challenge/send-code", method: "POST", body: { challengeId } }),
      transformResponse: unwrap,
    }),
    resendVerification: b.mutation<Verification & { verified?: boolean }, void>({
      query: () => ({ url: "/auth/verify-email/resend", method: "POST", body: {} }),
      transformResponse: unwrap,
    }),
    claimSession: b.mutation<{ claimed: true; session: Session } | { claimed: false; reason: string }, void>({
      query: () => ({ url: "/auth/claim", method: "POST", body: {} }),
      transformResponse: unwrap,
    }),
    confirmEmail: b.mutation<Session, { token: string; n?: string }>({
      query: (body) => ({ url: "/auth/verify-email", method: "POST", body }),
      transformResponse: unwrap,
    }),
    forgotPassword: b.mutation<Verification, { email: string }>({
      query: (body) => ({ url: "/auth/password/forgot", method: "POST", body }),
      transformResponse: unwrap,
    }),
    checkResetLink: b.mutation<{ ok: boolean }, { token: string; n?: string }>({
      query: (body) => ({ url: "/auth/password/check", method: "POST", body }),
      transformResponse: unwrap,
    }),
    resetPassword: b.mutation<{ updated: boolean }, { token: string; password: string }>({
      query: (body) => ({ url: "/auth/password/reset", method: "POST", body }),
      transformResponse: unwrap,
    }),
    logout: b.mutation<{ signedOut: boolean }, void>({ query: () => ({ url: "/auth/logout", method: "POST" }), transformResponse: unwrap }),
    acceptInvite: b.mutation<{ organizationId: string }, { token: string }>({ query: (body) => ({ url: "/auth/accept-invite", method: "POST", body }), transformResponse: unwrap }),

    plans: b.query<Catalogue, void>({ query: () => "/billing/plans", transformResponse: unwrap }),
    billingConfig: b.query<{ enabled: boolean; publishableKey: string | null }, void>({ query: () => "/billing/config", transformResponse: unwrap }),
    // Always fetched from the server; the client never does money maths. Amounts are display strings.
    credits: b.query<CreditsPanel, void>({ query: () => "/billing/credits", transformResponse: unwrap, providesTags: ["Credits"], keepUnusedDataFor: 0 }),
    /** Starts a prepaid top-up. `amount` is an exact deci-cent string from the server's top-up options. */
    topup: b.mutation<TopupStart, { amount: string; idempotencyKey: string; savedCard?: boolean }>({
      query: ({ amount, idempotencyKey, savedCard }) => ({ url: "/billing/topups", method: "POST", body: savedCard ? { amount, savedCard } : { amount }, headers: { "idempotency-key": idempotencyKey } }),
      transformResponse: unwrap,
    }),
    /** Saves a card without charging it. "card" unlocks the free credit; "auto_reload" is the off-session consent. */
    startSetup: b.mutation<SetupStart, { purpose: "card" | "auto_reload"; idempotencyKey: string }>({
      query: ({ purpose, idempotencyKey }) => ({ url: "/billing/setup-intents", method: "POST", body: { purpose }, headers: { "idempotency-key": idempotencyKey } }),
      transformResponse: unwrap,
    }),
    removeCard: b.mutation<{ removed: number }, void>({ query: () => ({ url: "/billing/card", method: "DELETE" }), transformResponse: unwrap, invalidatesTags: ["Credits"] }),
    closeAccount: b.mutation<{ closed: boolean }, { confirm: string }>({ query: (body) => ({ url: "/billing/close", method: "POST", body }), transformResponse: unwrap }),
    reverify: b.mutation<{ requeued: number }, void>({ query: () => ({ url: "/billing/reverify", method: "POST" }), transformResponse: unwrap, invalidatesTags: ["Credits", "Cockpit", "Nav"] }),
    /** Suggested top-ups, worked out by the server from the daily budget (or a budget being chosen in setup). */
    topupOptions: b.query<TopupOptions, { budget?: string } | void>({
      query: (q) => `/billing/topup-options${q && q.budget ? `?budget=${encodeURIComponent(q.budget)}` : ""}`,
      transformResponse: unwrap,
      providesTags: ["Credits"],
    }),
    /** An auto-reload waiting for the customer to approve it with their bank. */
    paymentToConfirm: b.query<PaymentToConfirm, string>({ query: (id) => `/billing/payments/${encodeURIComponent(id)}/confirm`, transformResponse: unwrap, keepUnusedDataFor: 0 }),
    payments: b.query<Paged<Payment[]>, { page: number }>({ query: (q) => `/billing/payments${qs(q)}`, transformResponse: paged<Payment[]>, providesTags: ["Billing"] }),

    onboarding: b.query<OnboardingState, void>({ query: () => "/onboarding", transformResponse: unwrap, providesTags: ["Onboarding"] }),
    onboardingStart: b.mutation<OnboardingState, { domain: string }>({
      query: (body) => ({ url: "/onboarding/start", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Org"],
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData("onboarding", undefined, data));
        } catch {}
      },
    }),
    onboardingUpdate: b.mutation<
      OnboardingState,
      Partial<{ facts: { key: FactKey; value: string }[]; groups: { id: string; on?: boolean; keywords?: string[] }[]; emailsPerDay: number; warmupDays: number; inboxesPerDomain: number; provider: string; fastStart: boolean }>
    >({
      query: (body) => ({ url: "/onboarding", method: "PATCH", body }),
      transformResponse: unwrap,
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData("onboarding", undefined, data));
        } catch {}
      },
    }),
    onboardingAnalyze: b.mutation<OnboardingState, void>({
      query: () => ({ url: "/onboarding/analysis", method: "POST" }),
      transformResponse: unwrap,
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData("onboarding", undefined, data));
        } catch {}
      },
    }),
    onboardingMarket: b.query<MarketView, string>({ query: () => "/onboarding/market", transformResponse: unwrap }),
    // `key` is the audience's current keywords, so the counts refetch after every edit.
    onboardingKeywords: b.query<KeywordCounts, { group: string; key: string }>({ query: ({ group }) => `/onboarding/keywords${qs({ group })}`, transformResponse: unwrap }),
    onboardingAnswers: b.mutation<OnboardingState, { sell: string; who: string; regions: string[] }>({
      query: (body) => ({ url: "/onboarding/answers", method: "POST", body }),
      transformResponse: unwrap,
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData("onboarding", undefined, data));
        } catch {}
      },
    }),
    onboardingPreview: b.mutation<OnboardingState, void>({
      query: () => ({ url: "/onboarding/preview", method: "POST" }),
      transformResponse: unwrap,
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData("onboarding", undefined, data));
        } catch {}
      },
    }),
    onboardingVolume: b.query<VolumeOptions, void>({ query: () => "/onboarding/volume", transformResponse: unwrap, providesTags: ["Onboarding"], keepUnusedDataFor: 0 }),
    skipCard: b.mutation<{ campaignId: string }, void>({ query: () => ({ url: "/onboarding/skip-card", method: "POST" }), transformResponse: unwrap, invalidatesTags: ["Onboarding", "Campaigns", "Cockpit", "Nav", "Settings"] }),
    notifyCapacity: b.mutation<{ notify: boolean }, void>({ query: () => ({ url: "/onboarding/notify-capacity", method: "POST" }), transformResponse: unwrap, invalidatesTags: ["Onboarding"] }),
    firstRun: b.mutation<OnboardingState, void>({ query: () => ({ url: "/onboarding/first-run", method: "POST" }), transformResponse: unwrap, invalidatesTags: ["Onboarding", "Cockpit"] }),
    launch: b.mutation<LaunchResult, void>({ query: () => ({ url: "/onboarding/launch", method: "POST" }), transformResponse: unwrap, invalidatesTags: ["Onboarding", "Campaigns", "Cockpit", "Nav", "Settings", "Autopilot"] }),

    cockpit: b.query<Cockpit, void>({ query: () => "/dashboard/cockpit", transformResponse: unwrap, providesTags: ["Cockpit"] }),
    performance: b.query<Performance, 7 | 30>({ query: (days) => `/dashboard/performance?days=${days}`, transformResponse: unwrap, providesTags: ["Cockpit"] }),
    budgetCard: b.query<BudgetCard, void>({ query: () => "/dashboard/budget", transformResponse: unwrap, providesTags: ["Cockpit"], keepUnusedDataFor: 0 }),
    navCounts: b.query<NavCounts, void>({ query: () => "/dashboard/nav-counts", transformResponse: unwrap, providesTags: ["Nav"] }),
    engineStop: b.mutation<{ stopped: boolean }, void>({
      query: () => ({ url: "/engine/stop", method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: ["Cockpit", "Nav", "Settings", "Autopilot", "Metrics"],
    }),
    engineStart: b.mutation<{ started: boolean }, void>({
      query: () => ({ url: "/engine/start", method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: ["Cockpit", "Nav", "Settings", "Autopilot"],
    }),

    inbox: b.query<Paged<InboxRow[], Meta & { counts: InboxCounts }>, { filter: string; reply?: string; page: number }>({
      query: (q) => `/inbox${qs(q)}`,
      transformResponse: paged<InboxRow[], Meta & { counts: InboxCounts }>,
      providesTags: ["Inbox"],
    }),
    thread: b.query<Thread, string>({ query: (id) => `/inbox/${id}`, transformResponse: unwrap, providesTags: (_r, _e, id) => [{ type: "Thread", id }] }),
    reply: b.mutation<{ sent: boolean }, { id: string; body: string }>({
      query: ({ id, body }) => ({ url: `/inbox/${id}/reply`, method: "POST", body: { body } }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, a) => [{ type: "Thread", id: a.id }, "Inbox", "Nav", "Cockpit"],
    }),
    dealClosed: b.mutation<{ closed: boolean; name: string }, string>({
      query: (id) => ({ url: `/inbox/${id}/deal-closed`, method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, id) => [{ type: "Thread", id }, "Inbox", "Nav", "Blocklist", "Contacts"],
    }),
    markHandled: b.mutation<{ handled: boolean }, string>({
      query: (id) => ({ url: `/inbox/${id}/handled`, method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, id) => [{ type: "Thread", id }, "Inbox", "Nav", "Cockpit"],
    }),
    removeConversation: b.mutation<{ removed: boolean; blocked: string; name: string }, string>({
      query: (id) => ({ url: `/inbox/${id}`, method: "DELETE" }),
      transformResponse: unwrap,
      invalidatesTags: ["Inbox", "Nav", "Blocklist", "Contacts", "Cockpit"],
    }),

    contacts: b.query<Paged<Contact[], Meta & { replyCounts: { byClass: Record<string, number>; urgent: number; replied: number } }>, Record<string, string | number | boolean | undefined>>({
      query: (q) => `/contacts${qs(q)}`,
      transformResponse: paged<Contact[], Meta & { replyCounts: { byClass: Record<string, number>; urgent: number; replied: number } }>,
      providesTags: ["Contacts"],
    }),
    contactStats: b.query<{ total: number; verified: number; companies: number; byStatus: Record<string, number>; byTier: Record<string, number> }, void>({
      query: () => "/contacts/stats",
      transformResponse: unwrap,
      providesTags: ["Contacts"],
    }),
    contact: b.query<{ contact: Contact; company: Company | null; messages: Pick<ThreadMessage, "id" | "direction" | "subject" | "body" | "intent" | "createdAt">[] }, string>({
      query: (id) => `/contacts/${id}`,
      transformResponse: unwrap,
      providesTags: ["Contacts"],
    }),
    importContacts: b.mutation<{ message: string; imported: number; duplicates: number; blocked: number; capped: number; totalRows: number; skippedRows: number; mapped: string[]; batchId: string | null }, { text: string; campaignId?: string }>({
      query: (body) => ({ url: "/contacts/import", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Contacts", "Batches", "Nav", "Cockpit", "Credits"],
    }),
    daily: b.query<{ date: string; sent: Contact[]; queued: Contact[]; counts: { sent: number; queued: number } }, { date?: string }>({
      query: (q) => `/daily${qs(q)}`,
      transformResponse: unwrap,
      providesTags: ["Contacts"],
    }),

    batches: b.query<Batch[], void>({ query: () => "/batches", transformResponse: unwrap, providesTags: ["Batches"] }),
    batch: b.query<Batch, string>({ query: (id) => `/batches/${id}`, transformResponse: unwrap, providesTags: ["Batches"] }),
    approveBatch: b.mutation<{ ok: boolean; approved: number; excluded: number; perDay: number }, { id: string; excludeContactIds: string[] }>({
      query: ({ id, excludeContactIds }) => ({ url: `/batches/${id}/approve`, method: "POST", body: { excludeContactIds } }),
      transformResponse: unwrap,
      invalidatesTags: ["Batches", "Contacts", "Nav", "Cockpit"],
    }),
    excludeFromBatch: b.mutation<{ excluded: number }, { id: string; contactIds: string[] }>({
      query: ({ id, contactIds }) => ({ url: `/batches/${id}/exclude`, method: "POST", body: { contactIds } }),
      transformResponse: unwrap,
      invalidatesTags: ["Batches", "Contacts", "Nav"],
    }),

    campaigns: b.query<Campaign[], void>({ query: () => "/campaigns", transformResponse: unwrap, providesTags: ["Campaigns"] }),
    campaign: b.query<Campaign, string>({ query: (id) => `/campaigns/${id}`, transformResponse: unwrap, providesTags: ["Campaigns"] }),
    createCampaign: b.mutation<Campaign, Record<string, unknown> & { name: string }>({ query: (body) => ({ url: "/campaigns", method: "POST", body }), transformResponse: unwrap, invalidatesTags: ["Campaigns", "Nav"] }),
    updateCampaign: b.mutation<Campaign, { id: string; patch: Record<string, unknown> }>({
      query: ({ id, patch }) => ({ url: `/campaigns/${id}`, method: "PATCH", body: patch }),
      transformResponse: unwrap,
      invalidatesTags: ["Campaigns"],
    }),
    setCampaignStatus: b.mutation<Campaign, { id: string; status: "ACTIVE" | "PAUSED" | "ARCHIVED" }>({
      query: ({ id, status }) => ({ url: `/campaigns/${id}/status`, method: "PATCH", body: { status } }),
      transformResponse: unwrap,
      invalidatesTags: ["Campaigns", "Nav", "Cockpit"],
    }),

    blocklist: b.query<Paged<BlockEntry[], Meta & { byReason: Record<string, number>; byOrigin: { you: number; automatic: number } }>, Record<string, string | number | undefined>>({
      query: (q) => `/blocklist${qs(q)}`,
      transformResponse: paged<BlockEntry[], Meta & { byReason: Record<string, number>; byOrigin: { you: number; automatic: number } }>,
      providesTags: ["Blocklist"],
    }),
    addBlock: b.mutation<{ value: string; message: string }, { value: string; entryType: "EMAIL" | "DOMAIN"; reason: string; note?: string }>({
      query: (body) => ({ url: "/blocklist", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Blocklist", "Nav", "Contacts"],
    }),
    removeBlock: b.mutation<{ removed: boolean }, string>({ query: (id) => ({ url: `/blocklist/${id}`, method: "DELETE" }), transformResponse: unwrap, invalidatesTags: ["Blocklist", "Nav"] }),
    restoreContact: b.mutation<{ message: string }, string>({
      query: (contactId) => ({ url: "/blocklist/restore", method: "POST", body: { contactId } }),
      transformResponse: unwrap,
      invalidatesTags: ["Blocklist", "Nav", "Contacts"],
    }),
    importBlocklist: b.mutation<{ message: string }, { text: string; blockWholeCompany: boolean }>({
      query: (body) => ({ url: "/blocklist/import", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Blocklist", "Nav", "Contacts"],
    }),

    settings: b.query<SettingsView, void>({ query: () => "/settings", transformResponse: unwrap, providesTags: ["Settings"] }),
    updateSettings: b.mutation<SettingsView, Partial<OrgSettings>>({
      query: (body) => ({ url: "/settings", method: "PATCH", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Settings", "Autopilot", "Metrics", "Nav", "Cockpit", "Credits"],
    }),
    saveCredential: b.mutation<CredentialStatus[], { provider: Provider; value: string }>({
      query: ({ provider, value }) => ({ url: `/settings/credentials/${provider}`, method: "PUT", body: { value } }),
      transformResponse: unwrap,
      invalidatesTags: ["Settings", "Autopilot", "Mailboxes"],
    }),
    removeCredential: b.mutation<CredentialStatus[], Provider>({
      query: (provider) => ({ url: `/settings/credentials/${provider}`, method: "DELETE" }),
      transformResponse: unwrap,
      invalidatesTags: ["Settings", "Autopilot", "Mailboxes"],
    }),
    autopilot: b.query<AutopilotStatus, void>({ query: () => "/settings/autopilot-status", transformResponse: unwrap, providesTags: ["Autopilot"] }),
    launchView: b.query<LaunchView, void>({ query: () => "/launch", transformResponse: unwrap, providesTags: ["Launch"] }),
    approveFirstBatch: b.mutation<{ approved: number }, { consent: boolean; excludeIds?: string[] }>({
      query: (body) => ({ url: "/launch/approve", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Launch", "Settings", "Cockpit", "Contacts"],
    }),
    approvePeople: b.mutation<{ approved: number }, { ids: string[]; consent: boolean }>({
      query: (body) => ({ url: "/launch/approve-people", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Launch", "Contacts", "Cockpit"],
    }),
    giveConsent: b.mutation<{ consent: boolean }, void>({ query: () => ({ url: "/launch/consent", method: "POST", body: { confirm: true } }), transformResponse: unwrap, invalidatesTags: ["Launch", "Settings"] }),
    vocab: b.query<VocabItem[], void>({ query: () => "/lead-status-vocab", transformResponse: unwrap, providesTags: ["Vocab"] }),
    saveVocab: b.mutation<VocabItem[], { items: { key: string; label: string; color?: string | null }[] }>({
      query: (body) => ({ url: "/lead-status-vocab", method: "PUT", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Vocab", "Inbox", "Thread"],
    }),
    discardDraft: b.mutation<{ discarded: boolean }, string>({
      query: (id) => ({ url: `/inbox/${id}/draft/discard`, method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, id) => ["Inbox", { type: "Thread", id }],
    }),
    correctIntent: b.mutation<{ intent: string | null; customerIntent: string }, { id: string; intent: string }>({
      query: ({ id, intent }) => ({ url: `/inbox/${id}/intent`, method: "POST", body: { intent } }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, { id }) => ["Inbox", { type: "Thread", id }],
    }),
    stopSequence: b.mutation<{ stopped: boolean }, string>({
      query: (id) => ({ url: `/contacts/${id}/stop`, method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: (_r, _e, id) => ["Contacts", "Inbox", { type: "Thread", id }],
    }),
    verifyEmail: b.mutation<{ ok: boolean; bad: boolean; transient: boolean; result: string; quality: string | null }, { email: string }>({ query: (body) => ({ url: "/settings/verify-email", method: "POST", body }), transformResponse: unwrap }),

    sourcingSearch: b.mutation<{ totalEntries: number; people: { id: string; name: string; title: string | null; company: string | null; location: string }[] }, { campaignId?: string; page?: number }>({
      query: (body) => ({ url: "/sourcing/search", method: "POST", body }),
      transformResponse: unwrap,
    }),
    sourcingImport: b.mutation<{ searched: number; enriched: number; inserted: number; duplicates: number; blocked: number; capped: number; noEmail: number; saturated: boolean }, { campaignId: string; maxEnrich: number }>({
      query: (body) => ({ url: "/sourcing/import", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Contacts", "Campaigns", "Batches", "Usage", "Nav", "Credits"],
    }),
    sourcingUsage: b.query<{ pacing: CreditPacing; days: { day: string; peopleEnriched: number; searches: number; emailsVerified: number; aiCalls: number }[] }, void>({
      query: () => "/sourcing/usage",
      transformResponse: unwrap,
      providesTags: ["Usage"],
    }),

    businessProfile: b.query<BusinessProfile, void>({ query: () => "/setup/profile", transformResponse: unwrap, providesTags: ["Settings"] }),
    saveBusinessProfile: b.mutation<BusinessProfile, Omit<BusinessProfile, "updatedAt" | "suggested">>({
      query: (body) => ({ url: "/setup/profile", method: "PUT", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Settings"],
    }),
    sequence: b.query<SequenceView, void>({ query: () => "/setup/sequence", transformResponse: unwrap, providesTags: ["Campaigns"] }),
    saveSequence: b.mutation<SequenceView, { touches: { subject: string | null; body: string }[] }>({
      query: (body) => ({ url: "/setup/sequence", method: "PUT", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Campaigns"],
    }),
    targeting: b.query<TargetingView, void>({ query: () => "/setup/targeting", transformResponse: unwrap, providesTags: ["Campaigns"] }),
    targetingCheck: b.mutation<TargetingImpact, { groups: TargetingEdit[] }>({ query: (body) => ({ url: "/setup/targeting/check", method: "POST", body }), transformResponse: unwrap }),
    saveTargeting: b.mutation<TargetingView, { groups: TargetingEdit[]; dropQueued: boolean }>({
      query: (body) => ({ url: "/setup/targeting", method: "PUT", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Campaigns", "Contacts", "Nav", "Cockpit"],
    }),
    siteCheck: b.query<SiteCheck, string>({
      query: (domain) => `/public/site-check?domain=${encodeURIComponent(domain)}`,
      transformResponse: unwrap,
      keepUnusedDataFor: 300,
    }),
    createOrganization: b.mutation<{ id: string; name: string; primaryDomain: string | null; existing?: boolean }, { name?: string; domain?: string }>({
      query: (body) => ({ url: "/organizations", method: "POST", body }),
      transformResponse: unwrap,
    }),
    /** Deletes the active workspace for everyone in it (owner only), confirmed by its name or website. */
    deleteWorkspace: b.mutation<{ deleted: boolean }, { confirm: string }>({
      query: (body) => ({ url: "/organizations/current", method: "DELETE", body }),
      transformResponse: unwrap,
    }),
    organization: b.query<{ id: string; name: string; primaryDomain: string | null; status: string; createdAt: string; webhookToken?: string }, void>({
      query: () => "/organizations/current",
      transformResponse: unwrap,
      providesTags: ["Org"],
    }),
    updateOrganization: b.mutation<{ id: string; name: string }, { name: string }>({ query: (body) => ({ url: "/organizations/current", method: "PATCH", body }), transformResponse: unwrap, invalidatesTags: ["Org"] }),
    members: b.query<Member[], void>({ query: () => "/organizations/current/members", transformResponse: unwrap, providesTags: ["Members"] }),
    invite: b.mutation<{ email: string; role: string; inviteToken: string; expiresInDays: number }, { email: string; role: string }>({
      query: (body) => ({ url: "/organizations/current/members", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Members"],
    }),
    changeRole: b.mutation<{ id: string; role: string }, { id: string; role: string }>({
      query: ({ id, role }) => ({ url: `/organizations/current/members/${id}`, method: "PATCH", body: { role } }),
      transformResponse: unwrap,
      invalidatesTags: ["Members"],
    }),
    removeMember: b.mutation<{ removed: boolean }, string>({ query: (id) => ({ url: `/organizations/current/members/${id}`, method: "DELETE" }), transformResponse: unwrap, invalidatesTags: ["Members"] }),

    systemLogs: b.query<Paged<SystemLog[], Meta & { openByLevel: Record<string, number> }>, { level?: string; open?: boolean; limit?: number }>({
      query: (q) => `/system-logs${qs(q)}`,
      transformResponse: paged<SystemLog[], Meta & { openByLevel: Record<string, number> }>,
      providesTags: ["Logs"],
    }),
    resolveLogs: b.mutation<{ cleared: number }, { id?: string }>({ query: (body) => ({ url: "/system-logs/resolve", method: "POST", body }), transformResponse: unwrap, invalidatesTags: ["Logs", "Nav"] }),

    adminOverview: b.query<Record<string, number>, void>({ query: () => "/admin/overview", transformResponse: unwrap, providesTags: ["Admin"] }),
    adminList: b.query<Paged<Record<string, unknown>[]>, { resource: string; params: Record<string, string | number | boolean | undefined> }>({
      query: ({ resource, params }) => `/admin/${resource}${qs(params)}`,
      transformResponse: paged<Record<string, unknown>[]>,
      providesTags: ["Admin"],
    }),
    adminOrganization: b.query<Record<string, unknown>, string>({ query: (id) => `/admin/organizations/${id}`, transformResponse: unwrap, providesTags: ["Admin"] }),
    adminUpdateUser: b.mutation<unknown, { id: string; patch: { status?: string; isPlatformAdmin?: boolean } }>({
      query: ({ id, patch }) => ({ url: `/admin/users/${id}`, method: "PATCH", body: patch }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminUpdateOrg: b.mutation<unknown, { id: string; status: "ACTIVE" | "SUSPENDED" }>({
      query: ({ id, status }) => ({ url: `/admin/organizations/${id}`, method: "PATCH", body: { status } }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminDomains: b.query<PoolDomain[], void>({ query: () => "/admin/domains", transformResponse: unwrap, providesTags: ["Admin"] }),
    adminAddDomain: b.mutation<AddedPoolDomain, NewPoolDomain>({
      query: (body) => ({ url: "/admin/domains", method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminAddMailbox: b.mutation<{ id: string; address: string; ok: boolean; error?: string }, NewPoolMailbox & { domainId: string; locale: string }>({
      query: ({ domainId, ...body }) => ({ url: `/admin/domains/${domainId}/mailboxes`, method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminDomainAction: b.mutation<unknown, { id: string; action: "dns-check" | "pause" | "retire"; reason?: string }>({
      query: ({ id, action, reason }) => ({ url: `/admin/domains/${id}/${action}`, method: "POST", body: reason ? { reason } : {} }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminMailboxAction: b.mutation<{ ok?: boolean; error?: string }, { id: string; action: "test" | "replies-only" | "retire"; username?: string; password?: string }>({
      query: ({ id, action, ...body }) => ({ url: `/admin/mailboxes/${id}/${action}`, method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminPool: b.query<AdminPoolView, void>({ query: () => "/admin/pool", transformResponse: unwrap, providesTags: ["Admin"] }),
    /** Recomputes the pool figures now instead of serving the copy cached every 15 minutes. */
    adminPoolRecompute: b.mutation<AdminPoolView, void>({ query: () => ({ url: "/admin/pool?fresh=1" }), transformResponse: unwrap, invalidatesTags: ["Admin"] }),
    adminDecideReorder: b.mutation<{ approved: boolean; suggestions: string[] }, { id: string; approve: boolean; note?: string }>({
      query: ({ id, ...body }) => ({ url: `/admin/pool/reorders/${id}`, method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminResumeDomain: b.mutation<{ resumed: boolean }, { id: string; reason: string }>({
      query: ({ id, reason }) => ({ url: `/admin/pool/domains/${id}/resume`, method: "POST", body: { reason } }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminActivateNow: b.mutation<{ domain: string; fromDay: number; bounce7: number }, { id: string; reason: string }>({
      query: ({ id, reason }) => ({ url: `/admin/pool/domains/${id}/activate-now`, method: "POST", body: { reason } }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminPoolSettings: b.query<PoolSettings, void>({ query: () => "/admin/pool/settings", transformResponse: unwrap, providesTags: ["Admin"] }),
    adminSavePoolSettings: b.mutation<PoolSettings, Partial<Omit<PoolSettings, "updatedAt">>>({
      query: (body) => ({ url: "/admin/pool/settings", method: "PATCH", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminPoolUnmatched: b.query<AdminUnmatchedInbound[], void>({ query: () => "/admin/pool/unmatched", transformResponse: unwrap, providesTags: ["Admin"] }),
    adminUnmatchedCandidates: b.query<AdminUnmatchedCandidate[], string>({ query: (id) => `/admin/pool/unmatched/${id}/candidates`, transformResponse: unwrap }),
    adminAssignUnmatched: b.mutation<{ assigned: boolean }, { id: string; contactId: string }>({
      query: ({ id, contactId }) => ({ url: `/admin/pool/unmatched/${id}/assign`, method: "POST", body: { contactId } }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminIntentCorrections: b.query<AdminIntentCorrections, number>({ query: (days) => `/admin/intent-corrections?days=${days}`, transformResponse: unwrap, providesTags: ["Admin"] }),
    adminHandleUnmatched: b.mutation<{ handled: boolean }, string>({
      query: (id) => ({ url: `/admin/pool/unmatched/${id}/handled`, method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminSetOrgKind: b.mutation<{ id: string; kind: OrgKind }, { id: string; kind: OrgKind }>({
      query: ({ id, kind }) => ({ url: `/admin/organizations/${id}/kind`, method: "POST", body: { kind } }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminCosts: b.query<CostPrices, void>({ query: () => "/admin/costs", transformResponse: unwrap, providesTags: ["Admin"] }),
    adminUpdateCosts: b.mutation<CostPrices, Partial<CostPrices>>({
      query: (body) => ({ url: "/admin/costs", method: "PATCH", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminSendNow: b.mutation<{ pushed: number; reason?: string }, string>({
      query: (id) => ({ url: `/admin/organizations/${id}/send-now`, method: "POST" }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin", "Cockpit", "Contacts"],
    }),
    adminUnpause: b.mutation<unknown, { id: string; reason: string }>({
      query: ({ id, reason }) => ({ url: `/admin/organizations/${id}/unpause`, method: "POST", body: { reason } }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminAdjustCredits: b.mutation<BalanceView, { id: string; amount: string; reason: string }>({
      query: ({ id, ...body }) => ({ url: `/admin/organizations/${id}/credits`, method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
    adminRefund: b.mutation<unknown, { id: string; amountCents?: number; reason?: string }>({
      query: ({ id, ...body }) => ({ url: `/admin/payments/${id}/refund`, method: "POST", body }),
      transformResponse: unwrap,
      invalidatesTags: ["Admin"],
    }),
  }),
});

export const {
  useProvidersQuery,
  useLoginMutation,
  useRegisterMutation,
  useChallengeStatusQuery,
  useChallengeCodeMutation,
  useChallengeSendCodeMutation,
  useResendVerificationMutation,
  useClaimSessionMutation,
  useConfirmEmailMutation,
  useForgotPasswordMutation,
  useCheckResetLinkMutation,
  useResetPasswordMutation,
  useLogoutMutation,
  useAcceptInviteMutation,
  usePlansQuery,
  useBillingConfigQuery,
  useTopupOptionsQuery,
  usePaymentToConfirmQuery,
  usePaymentsQuery,
  useOnboardingQuery,
  useFirstRunMutation,
  useOnboardingStartMutation,
  useOnboardingUpdateMutation,
  useOnboardingAnalyzeMutation,
  useOnboardingMarketQuery,
  useOnboardingKeywordsQuery,
  useOnboardingAnswersMutation,
  useOnboardingPreviewMutation,
  useLaunchMutation,
  useCockpitQuery,
  usePerformanceQuery,
  useBudgetCardQuery,
  useNavCountsQuery,
  useEngineStopMutation,
  useEngineStartMutation,
  useInboxQuery,
  useThreadQuery,
  useReplyMutation,
  useDealClosedMutation,
  useMarkHandledMutation,
  useRemoveConversationMutation,
  useContactsQuery,
  useContactStatsQuery,
  useContactQuery,
  useImportContactsMutation,
  useDailyQuery,
  useBatchesQuery,
  useBatchQuery,
  useApproveBatchMutation,
  useExcludeFromBatchMutation,
  useCampaignsQuery,
  useCampaignQuery,
  useCreateCampaignMutation,
  useUpdateCampaignMutation,
  useSetCampaignStatusMutation,
  useBlocklistQuery,
  useAddBlockMutation,
  useRemoveBlockMutation,
  useRestoreContactMutation,
  useImportBlocklistMutation,
  useSettingsQuery,
  useUpdateSettingsMutation,
  useSaveCredentialMutation,
  useRemoveCredentialMutation,
  useAutopilotQuery,
  useLaunchViewQuery,
  useApproveFirstBatchMutation,
  useApprovePeopleMutation,
  useGiveConsentMutation,
  useVocabQuery,
  useSaveVocabMutation,
  useDiscardDraftMutation,
  useCorrectIntentMutation,
  useStopSequenceMutation,
  useAdminUnmatchedCandidatesQuery,
  useAdminAssignUnmatchedMutation,
  useAdminIntentCorrectionsQuery,
  useVerifyEmailMutation,
  useSourcingSearchMutation,
  useSourcingImportMutation,
  useSourcingUsageQuery,
  useCreateOrganizationMutation,
  useOrganizationQuery,
  useDeleteWorkspaceMutation,
  useLazySiteCheckQuery,
  useBusinessProfileQuery,
  useSaveBusinessProfileMutation,
  useSequenceQuery,
  useSaveSequenceMutation,
  useTargetingQuery,
  useTargetingCheckMutation,
  useSaveTargetingMutation,
  useUpdateOrganizationMutation,
  useMembersQuery,
  useInviteMutation,
  useChangeRoleMutation,
  useRemoveMemberMutation,
  useSystemLogsQuery,
  useResolveLogsMutation,
  useAdminOverviewQuery,
  useAdminListQuery,
  useAdminOrganizationQuery,
  useAdminUpdateUserMutation,
  useAdminUpdateOrgMutation,
  useAdminRefundMutation,
  useAdminDomainsQuery,
  useAdminAddDomainMutation,
  useAdminAddMailboxMutation,
  useAdminDomainActionMutation,
  useAdminMailboxActionMutation,
  useCreditsQuery,
  useTopupMutation,
  useStartSetupMutation,
  useOnboardingVolumeQuery,
  useSkipCardMutation,
  useNotifyCapacityMutation,
  useRemoveCardMutation,
  useCloseAccountMutation,
  useReverifyMutation,
  useAdminPoolQuery,
  useAdminPoolRecomputeMutation,
  useAdminResumeDomainMutation,
  useAdminActivateNowMutation,
  useAdminPoolSettingsQuery,
  useAdminSavePoolSettingsMutation,
  useAdminPoolUnmatchedQuery,
  useAdminHandleUnmatchedMutation,
  useAdminSetOrgKindMutation,
  useAdminDecideReorderMutation,
  useAdminUnpauseMutation,
  useAdminSendNowMutation,
  useAdminCostsQuery,
  useAdminUpdateCostsMutation,
  useAdminAdjustCreditsMutation,
} = api;
