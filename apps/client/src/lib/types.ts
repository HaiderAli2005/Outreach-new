export type Role = "OWNER" | "ADMIN" | "MEMBER";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: Role;
  primaryDomain: string | null;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
  organizations: OrgSummary[];
  activeOrganizationId: string | null;
}

export interface Verification {
  email?: string;
  challengeId: string | null;
  matchNumber: number | null;
  codeSent: boolean;
}

export type AuthResult = Session | { verificationRequired: true; verification: Verification };

export const needsVerification = (r: AuthResult): r is { verificationRequired: true; verification: Verification } => "verificationRequired" in r;

export interface ChallengeState {
  status: "PENDING" | "APPROVED" | "FAILED" | "EXPIRED";
  purpose: "VERIFY" | "RESET" | null;
  attemptsLeft: number;
  expiresAt: string | null;
}

export interface Meta {
  page?: number;
  limit?: number;
  total?: number;
  [k: string]: unknown;
}

export interface Paged<T, M = Meta> {
  data: T;
  meta: M;
}

/** Money comes from the server as display strings ("$47.20") and exact deci-cent strings. The client never does money maths. */
export interface Catalogue {
  pricing: {
    /** One flat price for every email: "$0.04", a reply included. */
    perEmail: string;
    perEmailDeciCents: string;
    /** Cold email never spends the last of this; it is kept for replies in live conversations. */
    replyReserve: string;
    sequenceDays: number[];
    minTopup: string;
    minTopupDeciCents: string;
    /** Top-up cards are sized to the daily budget for these many days. */
    topupDays: number[];
    freeTrial: { amount: string; emails: number; people: number };
    included: string[];
    ownership: string;
  };
  /** The dashboard's daily budget control, in dollars. */
  budget: { minDeciCents: string; maxDeciCents: string; defaultDeciCents: string; presetsDeciCents: string[]; stops: { deciCents: string; emails: number; people: number }[] };
  /** Emails a day, as asked at setup and on the pricing page, every stop priced by the server. */
  volume: { min: number; max: number; step: number; presets: number[]; stops: VolumeStop[] };
  sizing: { sequenceSteps: number };
}

export interface BalanceView {
  balance: string;
  balanceDeciCents: string;
  available: string;
  held: string;
  emailsLeft: number;
  peopleLeft: number;
  pricePerEmail: string;
  sendRatePerDay: number;
  /** Deci-cents as a string; null = no cap (admin only). */
  dailyBudget: string | null;
  runwayDays: number | null;
  lastTopup: string | null;
  /** How long the balance lasts at the daily budget, in words ("about half a day"). */
  lasts: string | null;
  /** unfunded: no card yet. trial: only the free credit, nothing sent. low: under two days after sending started. */
  stage: "unfunded" | "trial" | "ok" | "low" | "reserve" | "empty";
  warnings: { low: boolean; runway: boolean; empty: boolean };
}

/** One stop on the emails-a-day slider, priced by the server. */
export interface VolumeStop {
  emails: number;
  perDay: string;
  perDayDeciCents: string;
  people: number;
  perMonth: string;
}

/** Step 5: what the pool can deliver for this customer. */
export interface VolumeOptions {
  ready: boolean;
  /** When there is no capacity yet: the date the first domains go live. */
  liveOn: string | null;
  min: number;
  max: number;
  step: number;
  presets: { emails: number; disabled: boolean; reason: string | null }[];
  recommended: number | null;
  stops: VolumeStop[];
}

export interface SetupStart {
  setupIntentId: string;
  clientSecret: string;
  paymentMethodId: string | null;
}

/** The dashboard's budget card. Money in deci-cent strings. */
export interface BudgetCard {
  budget: string | null;
  spentToday: string;
  emailsPerDay: number;
  sentToday: number;
  peopleToday: number;
  state: "running" | "reached" | "paused" | "uncapped";
  nudge: {
    hitAt: string | null;
    sentToday: number;
    waiting: number;
    raiseBy: string;
    raiseTo: string;
    /** Measured over the last 30 days; null until there is enough to measure. */
    replyRate: number | null;
    morePeoplePerMonth: number;
    moreRepliesPerMonth: number | null;
  } | null;
}

export type HealthStatus = "OK" | "WARNING" | "PAUSED";

export interface CreditsPanel extends BalanceView {
  health: { status: HealthStatus; label: string; bounceRate: string; delivered: number; bounced: number; replies: number; pausedReason: string | null };
  activity: { day: string; kind: "sent" | "topup" | "bonus" | "refund" | "correction"; emails: number | null; amount: string }[];
  hasCard: boolean;
  /** The saved card as the customer knows it, or null. */
  card: { brand: string; last4: string } | null;
  trialAvailable: boolean;
  minTopup: string;
}

export interface TopupStart {
  paymentIntentId: string;
  clientSecret: string;
  amount: string;
  /** Only for a payment on the saved card: Stripe's status straight after confirming it. */
  status?: string;
}

export interface Icp {
  industries: string[];
  titles: string[];
  sizes: string[];
  regions: string[];
}

export interface PreviewEmail {
  tab: string;
  day: string;
  subject: string;
  body: string;
  /** First name the email is signed with: the sending mailbox's persona. */
  sender?: string;
}

export interface SendingDomain {
  id: string;
  name: string;
  priceCents: number;
  status: "SELECTED" | "PENDING_REGISTRATION" | "REGISTERING" | "REGISTERED" | "FAILED";
  forwardTo: string | null;
  /** The domain originally picked, when it was taken at purchase time and a close alternative was registered. */
  replacedName?: string | null;
  prewarmed?: boolean;
  dnsVerifiedAt?: string | null;
  lastError?: string | null;
}

export interface Mailbox {
  id: string;
  sendingDomainId: string | null;
  address: string;
  provider: string;
  status: "PLANNED" | "PENDING" | "CREATING" | "CONNECTING" | "WARMING" | "ACTIVE" | "ERROR" | "RELEASED";
  warmupDays: number;
  dailyLimit: number;
  sendCap?: number | null;
  warmupStartedAt?: string | null;
  lastError?: string | null;
  sendingDomain?: { name: string; status: string } | null;
}

export type FactKey = "company" | "sell" | "who" | "where" | "proof";

export interface Fact {
  key: FactKey;
  label: string;
  value: string;
  source: string;
}

export interface BuyerGroup {
  id: string;
  priority: number;
  name: string;
  description: string;
  why: string;
  goals: string[];
  pains: string[];
  objections: string[];
  titles: string[];
  includeSimilarTitles: boolean;
  seniorities: string[];
  sizes: string[];
  regions: string[];
  keywords: string[];
  keywordSuggestions: string[];
  revenueRange: { min: number | null; max: number | null };
  technologies: string[];
  signals: { hiringForTitles: string[]; headcountGrowthPctMin: number | null; recentlyFunded: boolean };
  lookalikeDomains: string[];
  excludeDomains: string[];
  on: boolean;
}

export interface Sourced {
  text: string;
  source: string;
}

export interface BrandDetail {
  company_name: string;
  one_liner: string;
  offerings: string[];
  business_model: "B2B" | "B2C" | "both" | null;
  customer_types: string[];
  customer_size_hint: string | null;
  geographies: string[];
  price_level: string | null;
  proof: Sourced[];
  differentiators: Sourced[];
  named_customers: string[];
  buyer_titles_seen: string[];
  competitors: string[];
  language: string;
  brand_voice: string;
  confidence: number;
  evidence: { claim: string; source: string }[];
}

export interface AnalysisSummary {
  promptVersion: string;
  source: "site" | "answers";
  confidence: number;
  lowConfidence: boolean;
  brandDetail: BrandDetail;
  warning: string | null;
  repairsMade: string[];
}


export interface MarketView {
  available: boolean;
  reason: string | null;
  /** companiesInSample counts organisations inside the people sample, never the market. companies is a real total only when the paid count is on. */
  groups: { id: string; count: number | null; verified: number | null; companiesInSample?: number; companies?: number | null }[];
  people: number | null;
  verified: number | null;
  sample: { size: number; byCountry: [string, number][]; bySize: [string, number][]; bySeniority: [string, number][] };
  prospects: { audienceId?: string; firstName: string; lastInitial: string; title: string | null; company: string | null; country: string | null; hasEmail: boolean }[];
  /** Examples grouped from the people sample, not a market total. */
  companies?: { audienceId: string; name: string; domain: string | null; country: string | null; employees: number | null; description: string | null; people?: number; titles?: string[] }[];
  checkedAt: string;
}

export type KeywordState = "ok" | "none" | "broad";

export interface KeywordCounts {
  available: boolean;
  reason: string | null;
  groupId: string;
  baseline: number | null;
  keywords: { keyword: string; count: number | null; state: KeywordState | null }[];
}

export interface OnboardingRecord {
  id: string;
  domain: string;
  brand: string;
  summary: string | null;
  icp: Icp;
  preview: PreviewEmail[] | null;
  warmupDays: number;
  inboxesPerDomain: number;
  provider: "google" | "microsoft" | "mixed";
  analyzedAt: string | null;
  analysisError: string | null;
  paidAt: string | null;
  launchedAt: string | null;
  facts: Fact[];
  groups: BuyerGroup[];
  analysis: AnalysisSummary | null;
  siteReadable: boolean | null;
  fastStart: boolean;
}

export interface OnboardingState {
  onboarding: OnboardingRecord | null;
  /** True once money has gone in (a top-up or the free trial). */
  funded: boolean;
  credits: BalanceView;
  /** Emails a day as saved, or null when nothing is saved yet (the page starts from the recommendation). */
  emailsPerDay: number | null;
  /** Asked to be emailed when sending capacity is ready. */
  capacityNotify: boolean;
  campaign: { id: string; name: string; status: string } | null;
  aiAvailable: boolean;
  analysisStream?: boolean;
  analysisRun?: { id: string; status: "RUNNING" | "DONE" | "FAILED"; lastSeq: number; createdAt: string; error?: string | null } | null;
  sizeOptions: string[];
  scan?: { pagesRead: number; siteTitle: string | null; hasMx: boolean; hasSpf: boolean };
  /** After launch: the first search for people, with real counts. Null before launch. */
  firstRun?: FirstRun | null;
  /** False when no email checker is set up: nothing may then say addresses are checked. */
  verifying?: boolean;
}

export type FirstRunReason = "apollo-not-configured" | "sourcing-off" | "no-active-campaign" | "out-of-credits" | "nobody-found" | "error";

export interface FirstRun {
  state: "idle" | "running" | "done" | "failed";
  reason: FirstRunReason | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  found: number;
  verified: number;
  written: number;
  /** Nothing is sent until someone approves the first people. */
  needsApproval: boolean;
  approved: boolean;
  approveCount: number;
  consent: boolean;
  windowStart: string;
}

export interface DomainIdea {
  name: string;
  prefix: string;
  suffix: string;
  priceCents: number;
  available: boolean | null;
}

export type QuietReason = "autopilot-off" | "awaiting-approval" | "daily-cap" | "outside-window" | "nothing-ready" | "scheduling";

export interface SendingOutlook {
  next: string | null;
  nextProspectTz: string | null;
  /** Emails scheduled in the next 24 hours. */
  inDay: number;
  lastInDay: string | null;
  firstsToday: number;
  cap: number;
  window: { tz: string; start: string; end: string; days: number[]; open: boolean; closesAt: string | null; opensAt: string | null };
  reason: QuietReason | null;
}

export interface Cockpit {
  engine: { on: boolean; state: "running" | "unpaid" | "paused" | "reviewing" | "resting" | "capacity" | "reserve" | "approval" | "preparing"; todaySent: number; todayTarget: number; dayKey: string; weekday: number; window: string; windowStart: string; capacityLiveOn: string | null };
  budget: { emailsPerDay: number; perDay: string | null; deciCents: string | null };
  milestones: { contacts: boolean; sent: boolean; replied: boolean };
  /** When the next emails really go out, or why nothing is scheduled. */
  outlook: SendingOutlook;
  progress: { found: number; verified: number; written: number; sentEver: boolean; results: { sent: number; delivered: number; bounceRate: string; replies: number } };
  needsYou: {
    /** The first people waiting for the customer's approval before anything sends; null once approved or when not asked. */
    firstBatch: { ready: number; needed: number; finding: boolean; found: number; written: number; problem: string | null } | null;
    /** Found people with emails written, waiting on the approve page (not in a weekly list). */
    awaitingApproval: number;
    pendingWeeks: { batchId: string; weekStart: string; label: string; sendable: number; total: number }[];
    repliesWaiting: number;
    urgentReplies: number;
    latestReplies: {
      id: string;
      fullName: string | null;
      email: string;
      company: string | null;
      replyClass: string | null;
      replyUrgent: boolean;
      lastMessageAt: string | null;
      lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
      lastMessagePreview: string | null;
    }[];
  };
  week: { sent: number; replies: number; found: number; companies: number };
  lastWeek: { sent: number; replies: number; found: number; companies: number };
  heartbeat: { day: string; sent: number; replies: number }[];
  journey: { found: number; written: number; contacted: number; replied: number };
  activity: { type: string; at: string; title: string }[];
  markets: { id: string; name: string; contacted: number; replies: number; replyRate: number }[];
  credits: { balance: string; emailsLeft: number; runwayDays: number | null; lasts: string | null; stage: BalanceView["stage"]; warnings: BalanceView["warnings"] };
}

export interface PerformanceTotals {
  sent: number;
  firstEmails: number;
  followUps: number;
  delivered: number;
  bounced: number;
  replies: number;
  hot: number;
  spentDecicents: number;
  spent: string;
}

export type CampaignState = "sending" | "finding" | "waiting" | "paused" | "off" | "exhausted";

/** What went out, arrived, came back and cost in the chosen period, against the period before, and per campaign. */
export interface Performance {
  days: 7 | 30;
  series: { day: string; sent: number; delivered: number; bounced: number; replies: number; hot: number; spentDecicents: number }[];
  totals: PerformanceTotals & { pricePerEmail: string };
  previous: PerformanceTotals;
  audiences: { id: string; name: string; state: CampaignState; found: number; sent: number; perDay: number; replies: number; replyRate: number; hot: number; spent: string; costPerLead: string | null }[];
}

export type CostLineKey = "infrastructure" | "ai" | "data" | "verification" | "fees";

/** Internal only: what one email really costs, in US dollars, from the last 30 days at the saved unit prices. */
export interface CostStack {
  windowDays: number;
  paceDays: number;
  price: number;
  emails: number;
  lines: { key: CostLineKey; label: string; month: number; perEmail: number | null }[];
  total: { month: number; perEmail: number | null };
  margin: { perEmail: number | null; perEmailPct: number | null; revenueMonth: number; month: number; monthPct: number | null };
  ai: { byPurpose: { purpose: string; calls: number; usd: number; perCall: number; avgInputTokens: number; avgOutputTokens: number }[]; unmeasuredCalls: number };
  usage: { peopleEnriched: number; searches: number; emailsVerified: number; payments: number };
  perDomain: { id: string; domain: string; status: string; warmupDay: number | null; mailboxes: number; perDay: number; monthlyInfra: number; infraPerEmail: number | null; costPerEmail: number | null; marginPerEmail: number | null }[];
  pricesUpdatedAt: string;
}

export interface TokenPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export interface CostPrices {
  aiPrices: Record<string, TokenPrice>;
  apolloPerEnrichUsd: number;
  apolloPerSearchUsd: number;
  verifyPerEmailUsd: number;
  paymentFeePercent: number;
  paymentFeeFixedUsd: number;
  mailboxMonthUsd: number;
  repliesOnlyMailboxMonthUsd: number;
  domainYearUsd: number;
  updatedAt?: string;
}

export interface NavCounts {
  inboxAwaiting: number;
  leadsPending: number;
  activeCampaigns: number;
  blocklist: number;
  latestReplyAt: string | null;
  systemAlerts: number;
  browserNotifications: boolean;
  autopilotEnabled: boolean;
  leadSourcing: "AUTOMATIC" | "OFF";
  verifying: boolean;
  balance: string;
  emailsLeft: number;
  lowBalance: boolean;
  balanceStage: BalanceView["stage"];
}

export type ContactStatus = "NEW" | "PERSONALIZED" | "QUEUED" | "CONTACTED" | "REPLIED" | "NO_RESPONSE" | "BLOCKLISTED" | "UNSUBSCRIBED" | "BOUNCED" | "REJECTED";

export interface InboxRow {
  id: string;
  fullName: string | null;
  email: string;
  company: string | null;
  title: string | null;
  photoUrl: string | null;
  status: ContactStatus;
  tier: string | null;
  fitScore: number;
  replyClass: string | null;
  replyUrgent: boolean;
  followUpAt: string | null;
  repliedAt: string | null;
  lastMessageAt: string | null;
  lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  lastMessagePreview: string | null;
  messageCount: number;
  hasInbound: boolean;
  handledAt: string | null;
  hasDraft: boolean;
  needsReply: boolean;
  intent: Intent | null;
  customerIntent: string | null;
  temperature: "hot" | "warm" | "cold" | null;
  /** The customer's correction if any, else the model's intent. */
  leadStatus: string | null;
}

export type Intent = "INTERESTED" | "INFO_REQUEST" | "REFERRAL" | "NOT_NOW" | "NOT_INTERESTED" | "UNSUBSCRIBE" | "HOSTILE" | "UNCLEAR";

export interface VocabItem {
  key: string;
  label: string;
  color: string | null;
  sortOrder: number;
}

export interface InboxCounts {
  all: number;
  needs: number;
  replied: number;
  sent: number;
  urgent: number;
  byClass: Record<string, number>;
}

export interface ThreadMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  via: string | null;
  subject: string | null;
  body: string;
  /** The quoted history under an inbound reply, folded away by default. */
  quoted?: string | null;
  intent: string | null;
  createdAt: string;
  attachments: { url: string; name: string }[];
}

export interface Contact {
  id: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  industry: string | null;
  status: ContactStatus;
  personalizationStatus: string;
  personalization?: string | null;
  messageSubject?: string | null;
  followup2?: string | null;
  followup3?: string | null;
  followup4?: string | null;
  emailSource?: string | null;
  intent?: Intent | null;
  customerIntent?: string | null;
  sequenceStopReason?: string | null;
  campaignId: string | null;
  batchId: string | null;
  source: string;
  photoUrl: string | null;
  seniority: string | null;
  emailStatus: string | null;
  verifyResult: string | null;
  replyClass: string | null;
  replyUrgent: boolean;
  followUpAt: string | null;
  fitScore: number;
  tier: string | null;
  lastContactedAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  aiDraft?: string | null;
  handledAt?: string | null;
  autoReplyStatus?: string;
  neverAuto?: boolean;
  lastEscalationReason?: string | null;
  campaign?: { id: string; name: string } | null;
  /** When this person's next email is scheduled, and the zone they are emailed in. */
  nextTouchAt?: string | null;
  timezone?: string | null;
  prospectTz?: string;
}

export interface Thread {
  contact: Contact;
  campaign: { id: string; name: string; language: string } | null;
  messages: ThreadMessage[];
  email: { fromCompany: string | null; fromName: string | null; subject: string | null; signature: string; sentAt: string | null };
  /** A drafted reply. Only ever sent by a person pressing Send. */
  draft: { body: string; at: string | null } | null;
  intent: { model: Intent | null; customer: string | null; confidence: number | null; temperature: string | null; vocab: VocabItem[] };
  sequence: { stoppedAt: string | null; reason: string | null; nextAt: string | null };
  canReply: boolean;
  replyBlockedReason: "awaiting_their_reply" | "unsubscribed" | "no_thread" | null;
  coldMessageLeft: number | null;
}

export interface Company {
  domain: string;
  name: string | null;
  website: string | null;
  industry: string | null;
  employees: number | null;
  description: string | null;
  linkedinUrl: string | null;
}

export interface BatchStats {
  total: number;
  excluded: number;
  sendable: number;
  belowFloor: number;
  tierA: number;
  tierB: number;
  avgFit: number | null;
  pushed: number;
  byCampaign: { campaignId: string | null; name: string | null; count: number }[];
}

export interface Batch {
  id: string;
  weekStart: string;
  label: string;
  status: "SOURCING" | "REVIEW" | "APPROVED" | "SENDING" | "DONE";
  targetClean: number;
  sourcedClean: number;
  excludedCount: number;
  approvedCount: number | null;
  approvedAt: string | null;
  stats: BatchStats;
}

export interface Campaign {
  id: string;
  name: string;
  niche: string | null;
  marketBrief: string | null;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  language: string;
  apolloFilters: Record<string, unknown>;
  saturatedAt: string | null;
  createdAt: string;
  leadCount: number;
  verifiedCount: number;
  tierACount: number;
  contactedCount: number;
  replyCount: number;
  replyRate: number | null;
  dailyShare: number;
  tierBCount?: number;
}

export interface BlockEntry {
  id: string;
  entryType: "EMAIL" | "DOMAIN";
  value: string;
  reason: string;
  note: string | null;
  contactId: string | null;
  createdAt: string;
  /** "you" added it, or the product did on its own (unsubscribes, bounces, hostile replies). */
  origin: "you" | "automatic";
}

export type LaunchMode = "APPROVE_EACH" | "APPROVE_FIRST_BATCH" | "AUTO";

export interface ProofPoint {
  claim: string;
  source: string;
}

export interface OrgSettings {
  autopilotEnabled: boolean;
  weeklyBatchMode: boolean;
  autoApproveBatches: boolean;
  leadSourcing: "AUTOMATIC" | "OFF";
  perMailboxDailyCap: number;
  blocklistNoReplyDays: number;
  timezone: string;
  sendingWindowStart: string;
  sendingWindowEnd: string;
  language: string;
  personalizationEnabled: boolean;
  requireVerifiedEmail: boolean;
  monthlyCreditCap: number;
  dailyCreditCap: number;
  dailySourceTarget: number;
  apolloCycleResetDay: number;
  perCompanyContactCap: number;
  senderCompany: string | null;
  senderTitle: string | null;
  senderAddress: string | null;
  meetingLink: string | null;
  valueProp: string | null;
  optOutLine: string | null;
  browserNotifications: boolean;
  draftReplies: boolean;
  launchMode: LaunchMode;
  firstBatchApprovedAt: string | null;
  /** 1 = Monday .. 7 = Sunday, in the prospect's time zone. */
  sendDays: number[];
  prospectTimezone: string | null;
  /** Deci-cents as a string; null = no cap (admin only), "0" = paused. */
  dailyBudgetDecicents: string | null;
  /** Off by default. Charges the saved card once when the balance drops below the threshold, at most once a day. */
  autoReloadEnabled: boolean;
  autoReloadThresholdDecicents: string | null;
  autoReloadAmountDecicents: string | null;
  autoReloadLastAt: string | null;
  /** When and why the system switched auto-reload off. */
  autoReloadDisabledAt: string | null;
  autoReloadDisabledReason: string | null;
  /** The sentence the customer agreed to when they switched it on, and when. */
  autoReloadMandateText: string | null;
  autoReloadMandateAcceptedAt: string | null;
  proofPoints: ProofPoint[];
}

export type Provider = "APOLLO" | "MILLIONVERIFIER" | "SLACK_WEBHOOK";

export interface CredentialStatus {
  provider: Provider;
  source: "organization" | "platform" | null;
  masked: string | null;
}

export interface SettingsView {
  settings: OrgSettings;
  credentials: CredentialStatus[];
  limits: { maxDailyVolume: number; workingDaysPerMonth: number };
  aiAvailable: boolean;
  budget: { budget: string | null; spentToday: string; state: "uncapped" | "paused" | "reached" | "running" };
  consentOnRecord: boolean;
}

export interface LaunchEmail {
  step: number;
  day: number;
  subject: string | null;
  body: string | null;
}

export interface LaunchView {
  launchMode: LaunchMode;
  approved: boolean;
  approvedAt: string | null;
  needed: number;
  ready: number;
  preparing: number;
  consent: { at: string; text: string } | null;
  consentText: string;
  people: { id: string; name: string | null; email: string; title: string | null; company: string | null; emailSource: string | null; verified: string | null; emails: LaunchEmail[] }[];
}

export interface AutopilotStatus {
  on: boolean;
  readiness: { key: string; label: string; ok: boolean; optional?: boolean }[];
  ready: boolean;
  sending: { dailyTarget: number; csvQueued: number };
  sourcing: { dailyTarget: number; pacing: CreditPacing };
}

export interface CreditPacing {
  unlimited: boolean;
  spentCycle: number;
  spentToday: number;
  remainingCycle: number | null;
  allowanceToday: number | null;
}


export interface MailboxesView {
  connected: boolean;
  accounts: { id: number; from_email: string; from_name: string | null; warmup: string | null; attached: boolean }[];
  attached: number[];
  planned: Mailbox[];
  defaultCampaignId: string | null;
  accountsError?: string;
}

export interface Member {
  id: string;
  role: Role;
  status: "ACTIVE" | "INVITED";
  email: string | null;
  name: string | null;
  userId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SystemLog {
  id: string;
  organizationId: string | null;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  source: string;
  message: string;
  meta: unknown;
  resolvedAt: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  organizationId: string;
  stripePaymentIntentId: string;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  status: "REQUIRES_PAYMENT" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "DISPUTED";
  failureMessage: string | null;
  description: string | null;
  createdAt: string;
  refunds?: { id: string; amountCents: number; status: string; reason: string | null; createdAt: string }[];
  organization?: { id: string; name: string };
}

/** Suggested top-ups for a daily budget, worked out by the server. */
export interface TopupOptions {
  dailyBudget: string;
  emailsPerDay: number;
  /** "500 emails a day costs $20 a day. How long do you want to run?" */
  lead: string;
  balance: string;
  balanceLasts: string | null;
  minTopup: string;
  options: { days: number; label: string; deciCents: string; amount: string; emails: number; people: number; recommended: boolean }[];
}

export type PaymentToConfirm =
  | { status: "succeeded"; amount: string }
  | { status: "needs_confirmation"; clientSecret: string; paymentMethodId: string | null; amount: string };

/** The operator's pool console (/admin/pool). Never shown to customers. */
export type OrgKind = "CUSTOMER" | "INTERNAL";

/** A message read from a pool mailbox that matched no thread. */
export interface AdminUnmatchedInbound {
  id: string;
  fromEmail: string;
  subject: string | null;
  bodyText: string | null;
  rawHeaders: string | null;
  receivedAt: string;
  mailbox: { address: string };
}

export interface AdminUnmatchedCandidate {
  id: string;
  email: string;
  fullName: string | null;
  company: string | null;
  status: string;
  lastContactedAt: string | null;
  organization: { id: string; name: string };
}

export interface AdminIntentCorrections {
  days: number;
  total: number;
  confusions: { pair: string; count: number }[];
  rows: { id: string; intent: string | null; customerIntent: string | null; intentConfidence: number | null; intentCorrectedAt: string; replyClass: string | null; reply: string; organization: { id: string; name: string } }[];
}

export interface PoolDailyPoint {
  day: string;
  sends: number;
  bad: number;
  badRate: number | null;
  capacity: number | null;
  committed: number | null;
}

export interface PoolBurnImpact {
  mailboxes: number;
  domains: number;
  /** Emails a day the burned mailboxes could send before they burned. */
  capacityLost: number;
  monthlyCostCents: number;
  monthlyCost: string;
  /** People who replied in the last 30 days and are pinned to a burned mailbox. */
  liveConversations: number;
  /** People still in their sequence, whose follow-ups go out from a burned mailbox. */
  sequencesRunning: number;
  customersAffected: number;
}

export interface AdminPoolView {
  charts: {
    daily: PoolDailyPoint[];
    ewma: number[];
    domains: Record<PoolDomainStatus, number>;
    mailboxes: Record<PoolMailboxStatus, number>;
    burnImpact: PoolBurnImpact;
  };
  health: { activeDomains: number; activeMailboxes: number; warmingDomains: number; warmingMailboxes: number; repliesOnlyMailboxes: number; retiredThisMonth: number };
  burn: {
    degraded7: number;
    degraded30: number;
    ewmaWeeklyBurn: number;
    burnRatePerMonth: string;
    predicted30: { total: number; atRisk: number; background: number };
    weekly: number[];
    /** Average distinct customers per domain per day over the last 7 days. */
    dilution: number | null;
    dilutionRegime: string;
  };
  shelf: {
    warmShelf: number;
    runwayWeeks: number | null;
    reorderNeeded: boolean;
    domainsToBuy: number;
    reorderBecause: { burnReplacement: number; spareShortfall: number; demandShortfall: number; driver: "burnReplacement" | "spareShortfall" | "demandShortfall" | null };
    targets: { spareDomainsMin: number; spareMultiplier: number; maxBuyPerBatch: number; leadTimeWeeks: number; agingDays: number; warmupDays: number };
    pipeline: Record<string, number>;
    warming: PoolWarmingRow[];
  };
  /** Pool domains degraded or retired in the last 30 days, newest first. */
  burned: { id: string; domain: string; kind: "degraded" | "retired"; on: string; reason: string | null; reasonKind: "bounces" | "dkim" | "seed" | "other"; bounceRate: number | null; sends: number | null; daysLasted: number | null; forcedFromDay: number | null }[];
  /** Domains an operator promoted to active before their warmup finished. */
  forced: { id: string; domain: string; status: string; at: string; fromDay: number | null; reason: string | null; by: string | null; bounce7: number }[];
  capacity: { total: number; committed: number; internal: number; sentToday: number; headroom: string; roomFor500PerDay: number; domainDailyCap: number };
  /** Domains paused for an authentication failure or a provider block, waiting for an operator. */
  paused: { id: string; domain: string; since: string; reason: string | null }[];
  authentication: { unverified: { domain: string; spf: boolean; dkim: boolean; dmarc: boolean }[] };
  unmatched: { open: number; daily: { day: string; open: number }[] };
  cachedAt: string;
  cost: { monthlyRevenue: string };
  economics: CostStack;
  atRisk: { domain: string; sends7: number; bounce7: string; trend: string; risk: number; band: "at risk" | "watch" }[];
  footprint: Record<"registrar" | "nameserverSet" | "ipPool", { value: string; domains: number; share: string }[]>;
  reorders: { id: string; status: "PENDING" | "APPROVED" | "DONE" | "DISMISSED"; domainsToBuy: number; runwayWeeks: number | null; createdAt: string; decidedAt: string | null; note: string | null; suggestions: string[] }[];
}

export type PoolDomainStatus = "REGISTERED" | "AGING" | "WARMING" | "ACTIVE" | "DEGRADED" | "RETIRED";
export type PoolMailboxStatus = "CONNECTING" | "ERROR" | "WARMING" | "ACTIVE" | "REPLIES_ONLY" | "RETIRED";

export interface PoolMailbox {
  id: string;
  address: string;
  name: string | null;
  locale: string | null;
  status: PoolMailboxStatus;
  warmupDay: number;
  capToday: number;
  sentToday: number;
  smtpHost: string | null;
  imapHost: string | null;
  error: string | null;
}

export interface PoolDomain {
  id: string;
  name: string;
  status: PoolDomainStatus;
  warmed: boolean;
  region: string;
  registrar: string;
  dns: { spf: boolean | null; dkim: boolean | null; dmarc: boolean | null; selector: string | null; checkedAt: string | null };
  agingUntil: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  createdAt: string;
  sent7: number;
  mailboxes: PoolMailbox[];
}

export interface NewPoolMailbox {
  address: string;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface NewPoolDomain {
  name: string;
  warmed: boolean;
  region: string;
  locale: string;
  registrar?: string | null;
  dkimSelector?: string | null;
  mailboxes: NewPoolMailbox[];
}

export interface AddedPoolDomain {
  id: string;
  name: string;
  dns: { spf: boolean; dkim: boolean; dmarc: boolean; moved: "active" | "aging" | null };
  mailboxes: { id: string; address: string; ok: boolean; error?: string }[];
}

/** Whether a domain's site can be read, checked the moment the domain is entered. */
export interface SiteCheck {
  domain: string;
  status: "ok" | "missing" | "unreadable";
  reason: string | null;
  message: string | null;
  title: string | null;
}

/** Setup > Business profile: what the AI uses to write every email. */
export interface BusinessProfile {
  company: string;
  sell: string;
  who: string;
  where: string;
  offerings: string[];
  differentiators: string[];
  tone: string;
  proofPoints: { claim: string; source: string }[];
  updatedAt: string | null;
  /** Fields filled from the setup analysis and not saved yet. */
  suggested?: string[];
}

export interface SequenceTouch {
  step: number;
  day: number;
  subject: string | null;
  body: string;
}

export interface SequenceView {
  campaignId: string | null;
  campaignName: string | null;
  touches: SequenceTouch[];
  /** True while the sequence shown is still the setup sample, not yet saved for the campaign. */
  fromSample: boolean;
}

export interface TargetingGroup {
  id: string;
  name: string;
  description: string;
  on: boolean;
  titles: string[];
  keywords: string[];
  keywordSuggestions: string[];
  sizes: string[];
  regions: string[];
  matching: number | null;
  reachable: number | null;
  queued: number;
}

export interface TargetingView {
  groups: TargetingGroup[];
  matching: number | null;
  reachable: number | null;
  countedAt: string | null;
  sizeOptions: string[];
  launched: boolean;
  dropped?: number;
}

export type TargetingEdit = Pick<TargetingGroup, "id" | "on" | "titles" | "keywords" | "sizes" | "regions">;

export interface TargetingImpact {
  affected: { id: string; name: string; queued: number; off: boolean }[];
  queued: number;
}

export interface PoolWarmingRow {
  id: string;
  domain: string;
  status: "AGING" | "WARMING";
  warmupDay: number;
  daysRemaining: number;
  activeOn: string;
  capToday: number;
  mailboxes: number;
  bounce7: number;
  sends7: number;
  /** The ladder has not moved for 3 days or more: an operator should look. */
  held: boolean;
  behindDays: number;
}

export interface PoolSettings {
  spareDomainsMin: number;
  spareMultiplier: number;
  maxBuyPerBatch: number;
  maxBuyPerDay: number;
  autoBuyEnabled: boolean;
  updatedAt: string;
}
