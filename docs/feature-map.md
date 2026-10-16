# Feature map

Every feature found in `outreach-saas` (server controllers, libs, jobs, client pages, scripts) and where it
lives in the rebuild. Status markers: `[ ]` not started, `[~]` in progress / partial, `[x]` complete
end-to-end (UI → API → validation → service → database → integration → UI update).

Paths: web routes are under `apps/client/src/app`, API routes under `/api/v1`.

---

## Authentication and access

### Sign in / sign out / session check  `[x]`
Existing: `users-controller` login, logindetails, logout (plaintext passwords, 7-day JWT cookie, in-memory throttle, no signup).
New: web `/signin`, onboarding step 1 · API `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/me` · DB `User`, `RefreshToken` · bcrypt hashes, short-lived access JWT, rotating refresh cookie, Redis/memory rate limit, constant-time failure path.

### Registration  `[x]`
Existing: none (logins created by `scripts/add-user.js`). Required for a SaaS.
New: onboarding step 1 "Create account" · `/auth/register` · creates `User` + `Organization` + `OWNER` membership in one transaction.

### Google OAuth 2.0  `[x]`
Existing: none (design shows "Continue with Google").
New: `/auth/oauth/google/start` → `/auth/oauth/google/callback` (authorization code + PKCE + state) · `OAuthAccount`. Returns 503 when Google credentials are not configured.

### Team members and roles  `[x]`
Existing: several logins sharing one workspace (single tenant).
New: `/app/settings` Team tab · `/organizations/current/members` (list, invite by email, change role, remove) · `Membership` with `OWNER | ADMIN | MEMBER`. Invites create a pending membership + one-time token (`/auth/accept-invite`).

---

## Onboarding (design flow) mapped to existing functionality

### Domain analysis (brand research)  `[x]`
Existing: `POST /config/brand-setup` → `libs/brand.researchBrand` (site scrape + AI ICP).
New: landing hero + onboarding step 2 · `/onboarding/analysis` reads the homepage and up to 9 common subpages (public IPs only) and asks OpenAI for sourced facts (company, what you sell, who it's for, where, proof) plus 2 to 3 buyer groups · `Onboarding.facts`, `Onboarding.groups`. Facts are editable in place; groups can be switched on and off and the ICP is the union of the enabled groups. When the site can't be read, three questions (`/onboarding/answers`) build the same facts and groups. `/onboarding/market` sizes each group with Apollo (all and verified emails, 25 person sample) and caches it for 24h.

### Free sequence preview  `[x]`
Existing: `followups.buildSequence`, `personalize` (first email + 2 follow-ups).
New: onboarding step 3 · market card and sample prospects from `/onboarding/market`, first emails from `/onboarding/preview` (generated from the enabled groups, cached on `Onboarding.preview`), and a recommended pace that leaves at least 3 months of new people.

### Daily volume and plan  `[x]`
Existing: `default_daily_send_cap`, `per_mailbox_daily_cap`, credit caps.
New: onboarding step 4 + landing pricing · `/billing/plans` · `Plan` table (Launch/Growth/Scale), sizing rules (40 sends per warm inbox).

### Sending domains  `[~]`
Existing: none (source used pre-bought Smartlead mailboxes).
New: onboarding step 5 · `/onboarding/domains/ideas` (lookalike generator + real DNS lookup to flag registered names) · `SendingDomain`. Registration itself needs a registrar integration that neither source provides; purchased domains are stored as `PENDING_REGISTRATION` and shown as such. Documented in `migration-plan.md`.

### Inboxes and warmup plan  `[~]`
Existing: Smartlead mailbox listing + attach (`/smartlead/mailboxes`, `/smartlead/provision`).
New: onboarding step 6 · sending timeline (14 day warmup by default, first emails at 10 to 15 per inbox, full volume after a 14 day ramp), optional fast start with pre-warmed inboxes (`STRIPE_PRICE_INBOX_FAST`), up to 3 sender names rotated across addresses, `Mailbox` rows per domain · Settings → Sending lists real Smartlead mailboxes and attaches them. Creating Google/Microsoft inboxes is not in either source and stays `PENDING` until an inbox provider is integrated.

### Payment  `[x]`
Existing: none.
New: onboarding step 7 + `/app/billing` · `/billing/checkout` (Stripe subscription, `default_incomplete`, PaymentElement confirmation) · `Subscription`, `Payment`, `Invoice` rows synced from webhooks.

### Launch  `[x]`
Existing: `/smartlead/provision` (create campaign → sequence → schedule → settings → attach mailboxes → webhook → START).
New: onboarding step 8 · `/onboarding/launch` · creates the first `Campaign` from the analysis and provisions it in Smartlead when a key and mailboxes are available; otherwise reports exactly which prerequisite is missing. The launch page shows progress derived from real domain and mailbox statuses and can import a CSV of the user's own contacts into the campaign.

---

## Dashboard (cockpit)

### Engine state, today's sends, needs-you, week vs last week, 7-day heartbeat, journey, activity, markets  `[x]`
Existing: `GET /dashboard/cockpit`, client `app/page.js`.
New: `/app` · `/dashboard/cockpit` (tenant-scoped aggregates).

### Sidebar badges  `[x]`
Existing: `GET /dashboard/nav-counts`.
New: rail badges · `/dashboard/nav-counts`, polled every 60 s by RTK Query (paused while the tab is hidden). Optional browser notification when a new reply lands.

### Emergency stop / start  `[x]`
Existing: `POST /config/stop`, `/config/start` (switch off autopilot + auto-reply, cancel queued replies, pause/resume Smartlead campaigns).
New: cockpit engine card · `/engine/stop`, `/engine/start`.

---

## Inbox

### Conversation list with Needs reply / Replied / Sent / All filters and AI-class filter  `[x]`
Existing: `GET /inbox` + shared `libs/needsReply`.
New: `/app/inbox` · `/inbox` · `domain/needsReply.ts` is the single predicate used by the list and the badge.

### Thread view with AI draft and pending auto-reply preview  `[x]`
Existing: `GET /inbox/:id`.
New: `/app/inbox?c=<contactId>` · `/inbox/:contactId`.

### Human reply through Smartlead (opt-out guard, handoff before send, bookkeeping never fails a delivered reply)  `[x]`
Existing: `POST /inbox/:id/reply`.
New: `/inbox/:contactId/reply`.

### Deal closed / Mark handled / Remove person  `[x]`
Existing: `POST /inbox/:id/deal-closed`, `/handled`, `DELETE /inbox/:id`.
New: same actions under `/inbox/:contactId/*`.

---

## Leads

### Lead list with filters (status, tier, reply class, campaign, week, search), pagination, reply-class counts  `[x]`
Existing: `GET /contacts`. New: `/app/leads` · `/contacts`.

### Lead detail (contact + company + messages)  `[x]`
Existing: `GET /contacts/:id`, `ContactDetail.js`. New: lead drawer · `/contacts/:id`.

### Funnel stats  `[x]`
Existing: `GET /contacts/stats`. New: `/contacts/stats`.

### CSV export  `[x]`
Existing: `GET /contacts/export`. New: `/contacts/export`.

### CSV import with dedup, blocklist gate, per-company cap, week attachment  `[x]`
Existing: `POST /contacts/import`, `libs/leadImport`, `libs/dedup`. New: import dialog · `/contacts/import`.

### Today's list (sent + queued) and CSV  `[x]`
Existing: `GET /daily`, `/daily/export`. New: Leads "Sent by day" tab · `/daily`, `/daily/export`.

---

## Weekly batches (approval gate)

### List, pending, detail with live stats  `[x]`
Existing: `/batches`, `/batches/pending`, `/batches/:id`. New: Leads "Week review" tab · same routes.

### Exclude leads, approve week  `[x]`
Existing: `POST /batches/:id/exclude`, `/approve`. New: same.

### One-click approve link from Slack (HMAC token)  `[x]`
Existing: `GET /slack/approve`. New: `/public/batches/approve?batch=&token=` renders a design-system page.

### Auto-approve setting  `[x]`
Existing: `auto_approve_batches`. New: Settings → Autopilot.

---

## Campaigns

### List with live counts, reply rate, daily share  `[x]`
Existing: `GET /campaigns`. New: `/app/campaigns` · `/campaigns`.

### Detail  `[x]`
Existing: `GET /campaigns/:id`. New: `/app/campaigns/[id]`.

### Pause / resume (only active ⇄ paused)  `[x]`
Existing: `PATCH /campaigns/:id/status`. New: same.

### Campaign dossier export  `[x]`
Existing: `GET /campaigns/:id/export`. New: same.

### Create / edit / delete  `[x]` (behaviour changed deliberately)
Existing: disabled with 403 because the autopilot owned campaigns for one customer.
New: tenants create a campaign at launch and can create more from a saved audience (`POST /campaigns`); editing targeting is allowed only while `DRAFT` or `PAUSED`, which keeps the source's protection of a running campaign's state.

---

## Blocklist and suppression

### Rule list with filters, add email/domain, delete rule  `[x]`
Existing: `/blocklist` GET/POST/DELETE. New: `/app/blocklist` · same.

### Suppressed leads view + one-click restore with soft/hard rule safety  `[x]`
Existing: `/contacts?suppressed=1`, `POST /blocklist/restore`. New: same behaviour.

### Bulk import (lead CSV or plain list)  `[x]`
Existing: `POST /blocklist/import`. New: same.

### Export (leads + orphan rules)  `[x]`
Existing: `/blocklist/export`. New: same.

### Suppression rules (domain-level by default, free-mail email-only, target always suppressed, pause in-flight Smartlead leads)  `[x]`
Existing: `libs/suppress.blockEmail`. New: `domain/suppression.ts`.

---

## Settings

### Autopilot switch, daily source target (credit-locked), credit caps, send caps, meeting link, notifications  `[x]`
Existing: `GET/PATCH /config` with FIELDS whitelist and clamps. New: `/app/settings` · `/settings`.

### Auto-reply controls (mode off/shadow/canary/live, kill switch, limits, window, soft ack) with guarded promotion and queue voiding  `[x]`
Existing: `PATCH /config`, `/config/auto-reply/kill`, `/config/auto-reply/metrics`. New: `/settings`, `/settings/auto-reply/kill`, `/settings/auto-reply/metrics`.

### Integration keys (Apollo, Smartlead, MillionVerifier, Slack) masked on read  `[x]`
Existing: plaintext columns. New: `IntegrationCredential` encrypted with AES-256-GCM, masked on read.

### Verify one email (MillionVerifier test)  `[x]`
Existing: `GET /config/verify`. New: `/settings/verify-email`.

### Smartlead mailboxes + provision  `[x]`
Existing: `/smartlead/mailboxes`, `/smartlead/provision`. New: Settings → Sending · `/sending/mailboxes`, `/sending/provision`.

### Autopilot status panel (region, pacing, readiness checklist)  `[x]`
Existing: `GET /config/autopilot`. New: `/settings/autopilot-status`.

### Brand profile  `[x]`
Existing: locked `brand_profile` JSON seeded by migrations for one customer. New: generated per organization by onboarding analysis; value proposition, sender details, booking link and opt-out line are editable in Settings → Sender and brand.

---

## System log

### Log viewer, open counts, resolve one/all  `[x]`
Existing: `/dashboard/system-log`, `/dashboard/system-log/resolve`. New: `/app/system` · `/system-logs`.

### Health endpoints  `[x]`
Existing: `/healthz`, deep `/health`. New: `/healthz`, `/api/v1/health` (DB + Redis + open critical logs per platform).

---

## Integrations and webhooks

### Smartlead webhook: SENT, REPLY, BOUNCE, UNSUBSCRIBE, MANUAL_REPLY (echo detection)  `[x]`
Existing: `POST /webhooks/smartlead`. New: `/webhooks/smartlead/:orgToken` (per-organization URL shown in Settings → Integrations; events for another tenant's campaign are ignored) and the platform-level `/webhooks/smartlead?token=`, routed by Smartlead campaign id.

### Calendly webhook (meeting booked / cancelled)  `[x]`
Existing: `POST /webhooks/calendly`. New: `/webhooks/calendly/:orgToken` (the organization's random webhook token is the credential).

### Apollo waterfall webhook  `[x]`
Existing: `POST /webhooks/apollo`. New: `/webhooks/apollo/:orgToken`.

### Apollo people search preview / import  `[x]`
Existing: `/apollo/search`, `/apollo/import`. New: `/sourcing/search`, `/sourcing/import`.

### Apollo account-based import, signals refresh  `[ ]`
Existing: `/apollo/org-search`, `/apollo/import-accounts`, `/apollo/signals`. New: not ported. People search preview and import cover sourcing; account import and hiring/news signals fed Swedish-market scoring heuristics only.

### Apollo usage and plans  `[x]`
Existing: `/apollo/usage`, `/apollo/plans`. New: `/sourcing/usage`.

---

## Scheduled jobs

| Job | Existing | New | Status |
|---|---|---|---|
| send (verify → personalize → push, sized to capacity and batch share) | `sendJob` | `jobs/send.ts` | `[x]` |
| keepalive (restart paused/completed Smartlead campaign before push) | `sendJob.keepCampaignAlive` | inside `jobs/send.ts` | `[x]` |
| blocklist (reconcile + no-reply retirement, Smartlead status check) | `blocklistJob` | `jobs/blocklist.ts` | `[x]` |
| reply-sync (follow-up sweep, classify sweep) | `replySyncJob` | `jobs/replySync.ts` | `[~]` classify + follow-up sweeps ported; full Smartlead statistics reconciliation not ported |
| auto-reply-dispatch (re-evaluates every gate before sending) | `autoReplyDispatchJob` | `jobs/autoReplyDispatch.ts` | `[x]` |
| sourcing (Apollo search → enrich → dedup → score → insert into week batch) | `sourcingJob` | `jobs/sourcing.ts` | `[~]` core loop ported; region graduation, niche ladder and AI campaign generation were specific to one Swedish customer and are not ported |
| reverify (re-verify held emails) | `reverifyJob` | `jobs/reverify.ts` | `[x]` |
| batch-notify (approval nag with signed link) | `batchNotifyJob` | `jobs/batchNotify.ts` | `[x]` |
| reports (daily/weekly/monthly Slack summary) | `reportJob` | `jobs/report.ts` | `[x]` (summary text; CSV file upload to Slack dropped with `@slack/web-api`) |
| billing-sync (new) | — | `jobs/billingSync.ts` | `[x]` |

---

## Reply intelligence and the autonomous agent

### Classification into 13 classes with draft, return date, referral extraction  `[x]`
Existing: `libs/replyIntelligence.classifyReply`. New: `domain/replyIntelligence.ts` (prompt made brand-neutral, driven by the tenant's brand profile).

### Actions per class (lead flags, moved/referral handling, hard endings suppress)  `[x]`
Existing: `applyReplyActions`. New: same rules.

### Gate stack (kill switch, mode, never-auto, suppression, handoff, turn caps, gaps, daily caps, canary, window, class safety, confidence, hard stops)  `[x]`
Existing: `libs/autoReplyGate.evaluateGates`. New: `domain/autoReplyGate.ts`.

### Shadow log and metrics  `[x]`
Existing: `auto_reply_shadow_log`, `/config/auto-reply/metrics`. New: `AutoReplyDecision`, `/settings/auto-reply/metrics`.

### Attachment vision, language disagreement detector, reply guard validators  `[ ]`
Existing: `attachmentVision`, `replyGuard` (44 KB of Swedish-specific validators). Not ported; replies with attachments are escalated to a human instead.

---

## Billing and SaaS (new)

| Feature | New | Status |
|---|---|---|
| Plans catalogue | `/billing/plans` | `[x]` |
| Stripe customer management | `stripe.service.ensureCustomer` | `[x]` |
| Subscription checkout (plan + inbox quantity + one-time domain items) | `/billing/checkout` | `[x]` |
| Payment confirmation (PaymentElement) | onboarding step 7, `/app/billing` | `[x]` |
| Webhooks with signature verification and idempotency | `/billing/webhook` | `[x]` |
| Status sync (invoice.paid, payment_failed, subscription updated/deleted, charge.refunded) | `billing/webhook.service.ts` | `[x]` |
| Failed payment handling (past_due banner, send job pauses) | `requireActiveSubscription` in jobs | `[x]` |
| Customer portal | `/billing/portal` | `[x]` |
| Refunds (platform admin) | `/admin/payments/:id/refund` | `[x]` |
| Plan limits enforced (daily volume, campaigns) | `domain/entitlements.ts` | `[x]` |

## Platform admin (new)

| Feature | New | Status |
|---|---|---|
| Overview metrics | `/admin` · `/admin/overview` | `[x]` |
| Users (search, disable, grant platform admin) | `/admin/users` | `[x]` |
| Organizations (search, detail, suspend) | `/admin/organizations` | `[x]` |
| Subscriptions | `/admin/subscriptions` | `[x]` |
| Payments + refunds | `/admin/payments` | `[x]` |
| Webhook events | `/admin/webhook-events` | `[x]` |
| System logs across tenants | `/admin/system-logs` | `[x]` |

---

## Maintenance scripts from the source (`server/scripts`)

The 40 one-off scripts (probe-apollo, repair-*, backfill-*, seed-inbox-demo, verify-cutover-state…) were
operational repairs for one production database. They are not features and are not ported. `add-user.js`
is replaced by registration and invites. `run-migrations.js` is replaced by `prisma migrate deploy`.

---

## Added during the rebuild

| Feature | Where | Status |
|---|---|---|
| Outbound fetch guard (only public IPs, manual redirect checks) for every site read | `integrations/site.ts` | `[x]` |
| Create a workspace for a signed-in user without one (admin accounts, removed members) | `/app` empty state, `/onboarding` · `POST /organizations` | `[x]` |
| Email verification with number match, from RankHouse (on when Mailgun is set) | sign up / sign in waiting screen, `/verify` · `/auth/verify-email`, `/auth/challenge/*`, `/auth/claim` | `[x]` |
| Business analysis prompt v1: brand details, 3 to 6 ranked audiences, code checks with `repairsMade` (see `analysis.md`) | Analysis step · `/onboarding/analysis`, `/onboarding/answers` | `[x]` |
| Forgot password with number match, from RankHouse | `/forgot-password`, `/reset-password` · `/auth/password/*` | `[x]` |
| Accept a team invite by link | `/invite?token=` · `/auth/accept-invite` | `[x]` |
| Switch between organizations | rail select · `/auth/refresh` with `organizationId` | `[x]` |
