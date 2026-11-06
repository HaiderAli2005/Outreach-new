# Ordering new domains through InboxKit

Admin → Domains → **Order new domains** buys domains with 3 Google (or Microsoft) mailboxes each from InboxKit, with InboxKit's warmup on every mailbox. Aperture then follows each domain by itself, from InboxKit's setup through 28 days of warmup to sending, and cancels mailboxes at InboxKit when they retire.

## What the operator does

1. **Set up once** (Admin → Domains → InboxKit card):
   - Paste the InboxKit API key (InboxKit → Settings → API). Aperture checks it, keeps it in the secret store, and never shows it again. `INBOXKIT_API_KEY` in the server environment works too; the saved key wins.
   - Choose the InboxKit workspace. Aperture points that workspace's webhooks at `PUBLIC_API_URL/api/v1/inboxkit/webhook` automatically.
   - Fill in the registrant contact (InboxKit registers every domain with it) and where a domain forwards in a browser (your website).
   - Optional: warmup days (default 28), keep warmup on after sending starts (default on), highest domain price (default $20 a year).
2. **Order:**
   1. Press **Order new domains**. Aperture shows how many the pool needs and why. This uses the same restock maths as the daily reorder check: the spare minimum, the weekly burn rate and customer demand.
   2. Type how many. The price check finds clean, available names at InboxKit, plans 3 sender personas per domain, and shows the full cost and the wallet balance.
   3. Press **Order N domains · $X**. Nothing is bought before this.
3. **Watch** the **New domains** board: every domain's stage, its warmup day, its health, and when it will send.

## What happens by itself

| Stage | Aperture state | What moves it on |
|---|---|---|
| InboxKit is setting it up | domain `REGISTERED`, mailboxes `CREATING` | InboxKit marks each mailbox active. Aperture reads its app password (`show-credentials`), signs in over SMTP and IMAP, and stores the password in the secret store. The mailbox becomes `CONNECTING`. |
| Waiting for DNS | `REGISTERED` | SPF, DKIM and DMARC resolve, and the domain becomes `AGING`. |
| Warming at InboxKit | `AGING`, `externalWarmup` | 28 days counted from when warmup really started on the *last* mailbox. Nothing is sent by Aperture. |
| Held back | `AGING` with a reason | Warmup isn't running (paused, past due, missing), or health isn't excellent or good, or inbox rate is under 80%, or a mailbox can't sign in. The reason shows on the domain and in the system log. |
| Starting to send | `WARMING` from ladder day 8 | 10 a mailbox a day for a week, then 20, then 30. |
| Sending | `ACTIVE` | Unchanged pool rules. InboxKit warmup stays on, unless you switched that off, in which case it is cancelled once at this point. |
| Burned → retired | `REPLIES_ONLY` → `RETIRED` | Unchanged: it retires after 30 days with no reply and no sequence email in 7 days. The next sync then cancels it at InboxKit. |

The sync runs every 10 minutes (job `inboxkit-sync`), and a minute after any InboxKit webhook. **Sync now** on the board runs it immediately.

## Money safety

- Money is spent only on orders an operator confirmed, within **Pool settings**: at most `maxBuyPerBatch` (default 5) domains per batch and `maxBuyPerDay` (default 10) per day. Batches are 3 hours apart, and the rest of an order goes on the following days. This keeps a large order from looking like a snowshoe spam batch.
- Every domain is claimed before it is bought (PENDING → PLACING in one update), and placement holds a lock, so two runs can never buy the same domain.
- `POST /orders` is never retried automatically. An unclear answer (timeout, dropped connection, 5xx, 408, 409) leaves the domain PLACING:
  - If InboxKit lists it, it is adopted, even if that happens days later.
  - After 24 hours without it, it is marked "InboxKit never confirmed it" for an operator to check. It is never ordered again by Aperture.
- An empty wallet (402) buys nothing. The order waits ("Waiting for the InboxKit wallet") and carries on once you top up.
- **Cancel the rest** stops everything that isn't bought yet. It takes the same lock, so it can't race a batch, and a cancelled order never comes back.
- While Aperture follows domains in a workspace, it refuses to switch workspace, or to accept a key from another InboxKit account.

## Security

- The API key and the mailbox passwords live only in the secret store. They are never stored in Postgres, logged or returned.
- InboxKit signs webhooks with `sha256=` plus the SHA-256 of the API key. That value is the same on every request and the request body isn't part of it, so Aperture never trusts a webhook's contents. A valid one only triggers a sync that reads the state back from the API. The body, which carries plain-text passwords, is never stored. The signature header is redacted from logs.

## Mail during InboxKit warmup

While InboxKit warmup runs on a mailbox, any inbound mail that matches no conversation is filed as `warmup` (handled, nobody needs to look at it). A real reply to our email carries our thread headers and is matched before this rule applies.

## Code

| Area | Files |
|---|---|
| API client | `apps/server/src/integrations/inboxkit.ts` |
| Settings and status | `apps/server/src/domain/pool/inboxkit/settings.ts` |
| Plan, price check, confirm, batches, reconcile | `apps/server/src/domain/pool/inboxkit/orders.ts` |
| Sync (sign-in, DNS, warmup clock and health, ladder, cancel) | `apps/server/src/domain/pool/inboxkit/sync.ts` |
| Board | `apps/server/src/domain/pool/inboxkit/view.ts` |
| Admin API | `apps/server/src/modules/admin/inboxkit.admin.ts`, routes under `/api/v1/admin/inboxkit/*` |
| Webhook | `apps/server/src/modules/admin/inboxkit.webhook.ts`, `POST /api/v1/inboxkit/webhook` |
| Existing code touched | `lifecycle.ts` (ladder start day, supplier ladder), `restock.ts` (`onDnsReady`), `capacity.ts`, `sending/inbound.ts` (`warmup` kind), `manual.ts`, `pool/settings.ts` (race-safe first read), `jobs/*`, `config/env.ts`, `lib/logger.ts` |
| Database | migration `20261023120000_inboxkit_ordering`: `InboxKitSettings`, `SupplierOrder`, `SupplierOrderItem`, and new columns on `SendingDomain` and `Mailbox` |
| UI | `apps/client/src/components/admin/InboxKit.tsx`, `apps/client/src/app/admin/domains/page.tsx`, `apps/client/src/lib/poolOptions.ts`, `apps/client/src/app/globals.css` (`ik-*`) |
| Tests | `apps/server/test/inboxkit.test.ts`, `inboxkitClient.test.ts`, `inboxHistory.test.ts`; `apps/client/test/InboxKit.test.tsx` |

## Deploy

```
npm run prisma:deploy -w apps/server   # applies 20261023120000_inboxkit_ordering
```

In production, add the `inboxkit-sync` job to Cloud Scheduler every 10 minutes (`POST /api/v1/jobs/inboxkit-sync/run` with `X-Jobs-Secret`), like the other jobs.

## Not covered by InboxKit's API (checked 23 Oct 2026)

- There is no order-status endpoint for `/orders`. Aperture tracks orders through the domain and mailbox lists and webhooks.
- Domain registrations can't be cancelled through the API. A retired domain simply isn't renewed by the pool, but InboxKit may renew it yearly unless you switch renewal off in InboxKit.
- Pre-warmed inventory (`/prewarm/*`) isn't wired in yet. The same pipeline can take it later.
