# Aperture: the complete Stripe billing specification

Version 2. This supersedes the earlier Stripe spec and is consistent with the pricing and credits
decisions in `aperture-pricing-and-credits-spec.md` (spec 4).

You are working on the Aperture codebase (Turborepo: `apps/client` React, `apps/server`
Node/TypeScript + Prisma + Postgres).

## The model, stated once so nothing drifts

**Aperture sells prepaid credits at a flat $0.04 per email. There are no subscriptions, no plans,
no tiers, no recurring billing and no Stripe Checkout.**

```
customer sets a daily budget in dollars    →  that is the volume control
customer tops up                           →  balance goes up
emails are sent at $0.04 each              →  balance goes down
balance hits zero                          →  new sends stop, replies keep working
optional auto-reload                       →  tops up again before it runs out
```

Which means:

- **PaymentIntents**, confirmed in-page with Stripe Elements. Not Checkout Sessions.
- **No `customer.subscription.*` events.** Never subscribe to them, never handle them.
- **No Stripe Products and no Stripe Prices.** The amount is on the PaymentIntent. Nothing in the
  codebase should ever reference a `price_...` id.
- **No Billing Portal.** The customer manages everything inside Aperture.
- **No postpaid balance.** The money arrives before the emails go out, always.
- **Off-session charging exists in exactly one place**: auto-reload, which is off by default and
  requires an explicit recorded mandate. Nowhere else, ever. See §7.

### What changed from version 1

| | v1 | v2 |
|---|---|---|
| Price | $0.045 first touch / $0.025 follow-up | **flat $0.04 every email** |
| Top-up amounts | fixed list of five | **derived from the daily budget**, so validation changes (§4.2) |
| Off-session | forbidden everywhere | **permitted for auto-reload only**, with a mandate (§7) |
| Events | 6 | **7**, adding `payment_intent.requires_action` |

---

## 1. What has to be done in the Stripe dashboard

Manual, done by a person. Written here so the developer knows where the keys come from.

### 1.1 Keys

**Developers → API keys**, Test mode on:

| Key | Shape | Where it lives |
|---|---|---|
| Publishable | `pk_test_...` | served to the browser at runtime by `GET /billing/config` |
| Secret | `sk_test_...` | server only |

### 1.2 Local webhook

```bash
stripe login
stripe listen --forward-to localhost:4000/api/v1/billing/webhook
```

Prints a `whsec_...`, valid only while that command runs.

```bash
stripe trigger payment_intent.succeeded
stripe trigger charge.refunded
```

### 1.3 Deployed webhook

**Developers → Webhooks → Add endpoint**, URL `https://<api-host>/api/v1/billing/webhook`.

Subscribe to **exactly these seven and no others**:

```
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.processing
payment_intent.requires_action        ← new in v2, for off-session 3DS
charge.refunded
charge.dispute.created
charge.dispute.closed
```

**Do not subscribe to any `customer.subscription.*` or `invoice.*` event.** Aperture has neither.
Subscribing to events you do not handle is noise that hides a real problem.

Reveal the **Signing secret** and store it as `STRIPE_WEBHOOK_SECRET`. Test mode, live mode and
the CLI each have their own; they are not interchangeable.

---

## 2. Environment variables

```
STRIPE_SECRET_KEY=         # sk_test_... / sk_live_...   SERVER ONLY
STRIPE_PUBLISHABLE_KEY=    # pk_test_... / pk_live_...   safe in a browser
STRIPE_WEBHOOK_SECRET=     # whsec_...                   one per endpoint
```

Three variables. That is the complete list.

Validate all three as optional trimmed strings in `apps/server/src/config/env.ts`, and put
`STRIPE_SECRET_KEY` in `REQUIRED_KEYS` so **production refuses to start without it**, naming every
missing key at once. In development, warn and let billing return `503 NOT_CONFIGURED`.

Never bake the publishable key into the bundle. Serve it at runtime:

```ts
export function billingConfig() {
  return {
    enabled: features.stripe && !!env.STRIPE_PUBLISHABLE_KEY,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
  };
}
```

One build then works in test and in live.

---

## 3. The Stripe client

```ts
// apps/server/src/modules/billing/stripe.client.ts
import Stripe from "stripe";
import { env } from "../../config/env.js";
import { notConfigured } from "../../lib/errors.js";

let override: Stripe | null | undefined;   // test seam
let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (override !== undefined) return override;
  if (cached === undefined) {
    cached = env.STRIPE_SECRET_KEY
      ? new Stripe(env.STRIPE_SECRET_KEY, {
          apiVersion: "2026-09-30.endive",   // PIN IT. see §14.1
          maxNetworkRetries: 2,
          appInfo: { name: "Aperture" },
        })
      : null;
  }
  return cached;
}

export function requireStripe(): Stripe {
  const s = getStripe();
  if (!s) throw notConfigured("Billing (STRIPE_SECRET_KEY)");
  return s;
}

export function setStripeClient(client: Stripe | null | undefined): void {
  override = client;
}

/** Signature checking is pure crypto and needs no live key, so webhooks are testable without one. */
let verifier: Stripe | null = null;
export function webhookVerifier(): Stripe {
  verifier ??= new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_webhook_verification_only");
  return verifier;
}
```

`requireStripe()` throws `503 NOT_CONFIGURED`, never a 500.

---

## 4. Starting a top-up

Route: `POST /api/v1/billing/topups`, authenticated, manager role, private router.

### 4.1 Controller

```ts
export async function topup(req: Request, res: Response) {
  const key = req.get("idempotency-key") ?? "";
  if (!/^[\w-]{8,100}$/.test(key)) throw badRequest("An Idempotency-Key header is required");
  const amount = parseDeciCents((req.body as { amount?: unknown })?.amount);
  if (amount === null) throw badRequest("amount must be a whole number of deci-cents, as a string");
  return ok(res, await service.startTopup(ctx(req).orgId, currentUser(req).email, amount, key));
}
```

### 4.2 Amount validation — this is the part that changed

Top-up amounts are now **derived from the customer's daily budget** (`daily_budget × {3,7,14,30}`,
rounded up to $5, floor $25) plus a free-text "another amount" box. A fixed whitelist no longer
works.

**The server must still be the authority.** Never accept an arbitrary number because the client
sent it.

```ts
// apps/server/src/domain/money.ts
export const MIN_TOPUP: DeciCents  = 25_000n;      // $25
export const MAX_TOPUP: DeciCents  = 10_000_000n;  // $10,000; above this an operator handles it
export const DOLLAR: DeciCents     = 1_000n;

export function validateTopup(amount: DeciCents): string | null {
  if (amount % DOLLAR !== 0n) return "Top-ups are in whole dollars";
  if (amount < MIN_TOPUP)     return `The smallest top-up is ${formatUsd(MIN_TOPUP)}`;
  if (amount > MAX_TOPUP)     return `For more than ${formatUsd(MAX_TOPUP)}, contact us`;
  return null;
}
```

Three rules, not a list: whole dollars, at least $25, at most $10,000. The $10,000 ceiling is a
fraud brake; a stolen card should not be able to move five figures in one call.

The suggested amounts shown on the card are computed server-side from the budget and returned by
`GET /billing/topup-options`, so the client never does money arithmetic:

```ts
export function topupOptions(dailyBudget: DeciCents) {
  return [3, 7, 14, 30].map((days) => {
    const raw = dailyBudget * BigInt(days);
    const rounded = ((raw + 4_999n) / 5_000n) * 5_000n;        // up to the nearest $5
    const amount = rounded < MIN_TOPUP ? MIN_TOPUP : rounded;
    return {
      days,
      deciCents: amount.toString(),
      label: formatUsd(amount),
      emails: Number(amount / PRICE_PER_EMAIL),
      people: Math.floor(Number(amount / PRICE_PER_EMAIL) / TOUCHES_PER_PERSON),
      recommended: days === 7,
    };
  });
}
```

Because the price is flat, `emails` here is exact. There is no blend to be wrong about.

### 4.3 The PaymentIntent

```ts
export async function startTopup(orgId: string, email: string, amount: DeciCents, idempotencyKey: string) {
  const problem = validateTopup(amount);
  if (problem) throw unprocessable(problem);

  const payer = await customerOf(orgId);
  const stripe = requireStripe();
  const customerId = await ensureCustomer(payer, email);
  const autoReload = await autoReloadSettings(payer);

  const pi = await stripe.paymentIntents.create(
    {
      amount: toStripeCents(amount),
      currency: "usd",
      customer: customerId,
      // "off_session" ONLY when the customer has opted into auto-reload and accepted the mandate.
      // Otherwise "on_session": the card is remembered for a top-up they make themselves, and can
      // never be charged without them present.
      setup_future_usage: autoReload?.enabled ? "off_session" : "on_session",
      automatic_payment_methods: { enabled: true },
      description: `Aperture credits ${formatUsd(amount)}`,
      metadata: { organizationId: payer, kind: "topup", source: "manual", deciCents: amount.toString() },
    },
    { idempotencyKey: `topup:${idempotencyKey}` },
  );
  if (!pi.client_secret) throw unprocessable("Stripe did not return a payment to confirm");
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret, amount: formatUsd(amount) };
}
```

Non-negotiable:

- **`metadata` is load-bearing.** The webhook keys off `kind === "topup"` and credits `deciCents`.
  Without it a payment cannot be matched to an organization. `source` distinguishes a manual
  top-up from an auto-reload in the activity list.
- **The idempotency key comes from the client**, is pattern-validated, and is prefixed `topup:`.
  A refresh or a double click reuses the same PaymentIntent.
- **Only `clientSecret` is returned.** Never the whole PaymentIntent.

Money conversion:

```ts
export function toStripeCents(d: DeciCents): number {
  if (d % 10n !== 0n) throw new Error("Amount is not a whole number of cents");
  return Number(d / 10n);
}
export function fromStripeCents(cents: number): DeciCents {
  return BigInt(Math.round(cents)) * 10n;
}
```

---

## 5. The Stripe Customer and the saved card

```ts
export async function ensureCustomer(orgId: string, email: string): Promise<string> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const stripe = requireStripe();
  const customer = await stripe.customers.create(
    { email, name: org.name, metadata: { organizationId: orgId } },
    { idempotencyKey: `org:${orgId}:customer` },
  );
  await prisma.organization.update({ where: { id: orgId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}
```

`Organization.stripeCustomerId` must be `@unique`. **That index is what lets the webhook map a
Stripe customer back to an org.**

`hasCard` asks Stripe rather than keeping a local copy, so it can never be stale. `DELETE
/api/v1/billing/card` detaches every saved payment method, **and must also switch auto-reload
off**, because a reload with no card is a guaranteed failure.

Both must be reachable by the customer without contacting support. That is a deliberate
differentiator against the competitor's "no way of cancelling credit card once added" reviews, and
it must not be quietly dropped.

---

## 6. The webhook

### 6.1 Raw body

`express.json()` parses the body and discards the original bytes. Stripe's signature is computed
over those exact bytes.

```ts
// apps/server/src/app.ts, before any route
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      if ((req as express.Request).originalUrl?.startsWith("/api/v1/billing/webhook")) {
        (req as express.Request).rawBody = Buffer.from(buf);
      }
    },
  }),
);
app.set("trust proxy", 1);
```

### 6.2 Route

```
POST /api/v1/billing/webhook
```

On the **public, unauthenticated** billing router, mounted before the authenticated one. No auth,
no CSRF, **no rate limiter** (Stripe retries hard and a 429 reads as an outage).

### 6.3 Signature

```ts
export function verifyStripeEvent(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) throw badRequest("Stripe webhook secret is not configured");
  if (!rawBody || !signature) throw badRequest("Missing Stripe signature");
  try {
    return webhookVerifier().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw badRequest("Invalid Stripe signature");
  }
}
```

Bad signature → **400**, nothing written. There must be a test asserting the row count is
unchanged after a forged request.

### 6.4 Duplicate protection

```prisma
model WebhookEvent {
  id          String    @id @default(cuid())
  provider    String
  externalId  String
  type        String
  payload     Json
  status      String    @default("RECEIVED")   // RECEIVED|PROCESSED|IGNORED|FAILED
  error       String?
  processedAt DateTime?
  createdAt   DateTime  @default(now())
  @@unique([provider, externalId])
}
```

```ts
export async function handleStripeWebhook(event: Stripe.Event): Promise<{ duplicate: boolean }> {
  const key = { provider_externalId: { provider: "STRIPE" as const, externalId: event.id } };
  let row = await prisma.webhookEvent.findUnique({ where: key });
  if (row && row.status !== "FAILED") return { duplicate: true };   // FAILED rows ARE retried
  if (!row) {
    try {
      row = await prisma.webhookEvent.create({
        data: { provider: "STRIPE", externalId: event.id, type: event.type, payload: event as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { duplicate: true };
      throw err;
    }
  }
  try {
    const handled = await dispatchStripeEvent(event);
    await prisma.webhookEvent.update({
      where: { id: row.id },
      data: { status: handled ? "PROCESSED" : "IGNORED", processedAt: new Date(), error: null },
    });
    return { duplicate: false };
  } catch (err) {
    logger.error({ err, eventId: event.id, type: event.type }, "stripe webhook failed");
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
    throw err;   // the 500 makes Stripe retry
  }
}
```

Three independent layers, all needed:

1. The unique `(provider, externalId)` index short-circuits a repeat delivery.
2. The unique-violation catch handles two deliveries racing on the insert.
3. The ledger is separately idempotent on the PaymentIntent id (§8).

### 6.5 Events

```ts
export async function dispatchStripeEvent(event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await upsertPayment(pi, "SUCCEEDED");
      await onTopupSucceeded(pi);
      return true;
    }
    case "payment_intent.payment_failed":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "FAILED");
      await onPaymentFailed(event.data.object as Stripe.PaymentIntent);   // may disable auto-reload
      return true;
    case "payment_intent.requires_action":
      // An off-session auto-reload needs the customer to authenticate. Disable auto-reload and
      // email them a link; never try again silently.
      await onRequiresAction(event.data.object as Stripe.PaymentIntent);
      return true;
    case "payment_intent.processing":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "PROCESSING");
      return true;
    case "charge.refunded":
      await onChargeRefunded(event.data.object as Stripe.Charge);
      return true;
    case "charge.dispute.created":
      await onDisputeOpened(event.data.object as Stripe.Dispute);
      return true;
    case "charge.dispute.closed":
      await onDisputeClosed(event.data.object as Stripe.Dispute);
      return true;
    default:
      return false;   // recorded IGNORED, still 200
  }
}
```

Seven cases. Nothing about subscriptions or invoices.

### 6.6 Status codes

```
200   processed, or a duplicate         → Stripe stops
400   bad signature / no raw body       → nothing written, Stripe stops
500   handler threw                     → row marked FAILED, Stripe retries
```

Never return 200 on a failure to keep Stripe quiet. The retry is the recovery mechanism.

---

## 7. Auto-reload

The one place off-session charging is permitted. It exists because the product is prepaid and a
customer should not have their sending stop at 2am over a balance.

### 7.1 Settings and the mandate

```sql
CREATE TABLE auto_reload_settings (
  organization_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  threshold_decicents   bigint  NOT NULL,
  amount_decicents      bigint  NOT NULL,
  mandate_text          text    NOT NULL,
  mandate_accepted_at   timestamptz NOT NULL,
  mandate_ip            text,
  mandate_user_id       uuid,
  last_charged_at       timestamptz,
  last_failure          text,
  disabled_reason       text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

**Off by default.** A customer who never opts in can never be charged without pressing a button.

Turning it on records the exact wording they agreed to, with timestamp, user and IP. That record
is the mandate, and it is what makes an off-session charge legitimate. Store the sentence shown
on screen, verbatim:

> When my balance drops below $40, charge my saved card $140. At most one charge a day. I can turn
> this off at any time.

Defaults offered when they opt in: threshold = 2 days of their daily budget, amount = the top-up
they last chose. Both editable.

### 7.2 The trigger

**Never charge inside the send pipeline.** A send must not block on a card.

```
after a ledger debit commits:
    if auto_reload.enabled
    and balance < threshold
    and last_charged_at is null or older than 24h
    and no reload job already queued for this org
        → enqueue runAutoReload(orgId)
```

The queue, not the request, does the charging. Take a per-org lock in the job so two concurrent
sends cannot both reload.

### 7.3 The charge

```ts
export async function runAutoReload(orgId: string) {
  const s = await autoReloadSettings(orgId);
  if (!s?.enabled) return { skipped: "disabled" };
  if (s.lastChargedAt && Date.now() - s.lastChargedAt.getTime() < 86_400_000) return { skipped: "cooldown" };
  if ((await balanceOf(orgId)) >= s.thresholdDeciCents) return { skipped: "balance-recovered" };

  const stripe = requireStripe();
  const customerId = await requireCustomerId(orgId);
  const pms = await stripe.paymentMethods.list({ customer: customerId, limit: 1 });
  const pm = pms.data[0];
  if (!pm) return disableAutoReload(orgId, "no saved card");

  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    await stripe.paymentIntents.create(
      {
        amount: toStripeCents(s.amountDeciCents),
        currency: "usd",
        customer: customerId,
        payment_method: pm.id,
        off_session: true,
        confirm: true,
        description: `Aperture credits ${formatUsd(s.amountDeciCents)} (auto-reload)`,
        metadata: { organizationId: orgId, kind: "topup", source: "auto_reload", deciCents: s.amountDeciCents.toString() },
      },
      { idempotencyKey: `autoreload:${orgId}:${dayKey}` },
    );
    await markAutoReloadCharged(orgId);
  } catch (err) {
    const e = err as Stripe.errors.StripeError;
    if (e.code === "authentication_required") {
      await disableAutoReload(orgId, "the card needs authentication");
      await emailAuthenticationNeeded(orgId, e.payment_intent?.id);
    } else {
      await disableAutoReload(orgId, e.message ?? "the card was declined");
      await emailAutoReloadFailed(orgId, e.message);
    }
  }
}
```

Points that matter:

- **The idempotency key contains the date**, so Stripe itself enforces at most one auto-reload per
  org per day even if the job runs twice.
- **The balance is re-checked inside the job.** A manual top-up between enqueue and run cancels it.
- **Any failure disables auto-reload and emails the customer.** It is never retried silently. A
  card that declines twice in the night is how a customer ends up with four support tickets and a
  chargeback.
- **`authentication_required` is a separate case.** Some cards, especially in Europe under SCA,
  refuse off-session charges and demand the customer authenticate. That is not a decline; email
  them a link to confirm the payment, and leave auto-reload off until they do.
- Crediting needs no new code: the metadata is `kind: "topup"`, so `payment_intent.succeeded`
  flows through the same `onTopupSucceeded` path as a manual top-up.

### 7.4 When it switches itself off

```
card removed                    → disable
card declined                   → disable + email
authentication required         → disable + email with a link
dispute opened on the account   → disable
account closed                  → disable
```

Each one writes `disabled_reason`, and the credits page shows it plainly rather than silently
leaving the switch off.

---

## 8. The ledger

```ts
async function onTopupSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "topup") return;
  const orgId = pi.metadata.organizationId || (await orgForCustomer(pi.customer as string));
  if (!orgId) return;
  const asked = parseDeciCents(pi.metadata.deciCents);
  const received = fromStripeCents(pi.amount_received || pi.amount);
  // Trust the metadata only when it does not exceed what Stripe actually collected.
  const amount = asked !== null && asked <= received ? asked : received;
  const note = pi.metadata.source === "auto_reload" ? `Auto top-up ${formatUsd(amount)}` : `Top-up ${formatUsd(amount)}`;
  const r = await credit(orgId, "TOPUP", amount, { ref: pi.id, note });
  if (r.ok && !r.duplicate) await logSystem(orgId, "INFO", "billing", `Added ${formatUsd(amount)} in credits.`);
}
```

```ts
export async function credit(
  orgId: string,
  kind: "TOPUP" | "BONUS" | "REFUND",
  amount: DeciCents,
  opts: { ref?: string | null; note?: string | null } = {},
): Promise<CreditResult> {
  if (amount <= 0n) return { ok: false, reason: "Amount must be positive" };
  const customerId = await customerOf(orgId);
  return withCustomerLock(customerId, async (tx) => {
    if (opts.ref) {
      const seen = await tx.creditLedger.findUnique({
        where: { kind_stripeRef: { kind, stripeRef: opts.ref } }, select: { id: true },
      });
      if (seen) return { ok: true as const, balance: await balanceOf(customerId, tx), duplicate: true };
    }
    const row = await append(tx, customerId, { kind, amount, stripeRef: opts.ref ?? null, note: opts.note ?? null });
    return { ok: true as const, balance: row.balanceAfter };
  });
}

export function withCustomerLock<T>(customerId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"credits:" + customerId}))`;
      return fn(tx);
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}
```

The rules behind that code, each load-bearing:

- **No mutable balance column.** The balance is the `balanceAfter` of the newest row, ordered by a
  `seq bigserial`. A column that gets updated will drift and you will never find out when.
- **The duplicate check and the insert are in the same transaction, under the lock.**
  Check-then-insert without the lock is a race that double-credits under concurrent webhooks.
- **Two database guarantees, not just application code:**

```sql
CREATE UNIQUE INDEX ON credit_ledger (kind, stripe_ref);
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_balance_after_nonnegative CHECK (balance_after >= 0);
```

  **Both must be in the applied migration, not only in the Prisma schema.**

The free trial uses the same path with a deterministic ref, so it can only be claimed once:

```ts
await credit(payer, "BONUS", FREE_TRIAL_DECICENTS, { ref: `trial:${payer}`, note: "Free trial" });
```

`FREE_TRIAL_DECICENTS = 10_000n` ($10). At the flat $0.04 that is **exactly 250 emails**, and the
copy must say 250, not a blended estimate.

---

## 9. Refunds

Admin-initiated, `POST /api/v1/admin/payments/:id/refund`, platform-admin gated.

```ts
const refund = await requireStripe().refunds.create(
  { payment_intent: payment.stripePaymentIntentId, amount, reason: "requested_by_customer", metadata: { note, adminId } },
  { idempotencyKey: `refund:${payment.id}:${payment.amountRefundedCents}:${amount}` },
);
```

The key encodes the already-refunded total, so retrying the same partial refund is safe while a
genuinely different second partial refund still goes through.

`charge.refunded` claws back only the **newly** refunded delta:

```ts
const newly = refunded - payment.amountRefundedCents;
if (newly > 0) {
  const r = await debitCorrection(payment.organizationId, fromStripeCents(newly), `top-up refunded (${charge.id})`);
  if (!r.ok) await logSystem(payment.organizationId, "WARN", "billing", `A refund of ${formatUsd(fromStripeCents(newly))} was larger than the unspent balance: ${r.reason}.`);
}
```

A refund larger than the unspent balance **logs a warning and returns 200**. Failing the webhook
would make Stripe retry forever over something a retry cannot fix.

---

## 10. Disputes

A chargeback means the money is already gone and the bank is deciding.

```ts
async function onDisputeOpened(dispute: Stripe.Dispute): Promise<void> {
  const payment = await paymentForCharge(dispute.charge);
  if (!payment) return;
  await prisma.payment.update({ where: { id: payment.id }, data: { status: "DISPUTED" } });
  await debitCorrection(payment.organizationId, fromStripeCents(dispute.amount), `disputed (${dispute.id})`);
  await disableAutoReload(payment.organizationId, "a payment was disputed");
  await pauseOrganization(payment.organizationId, `A payment was disputed (${dispute.id}).`);
  await logSystem(payment.organizationId, "CRITICAL", "billing", `Chargeback opened: ${formatUsd(fromStripeCents(dispute.amount))}.`);
}
```

Pause on open, do not wait for the outcome. A disputed account is either fraud or a very unhappy
customer, and in both cases more sending from our domains is the wrong move. On
`charge.dispute.closed` with `status === "won"`, credit it back and resume.

---

## 11. Reconciliation

```ts
export async function runBillingSyncJob() {
  const stripe = getStripe();
  if (!stripe) return { skipped: "stripe-not-configured" };
  const since = Math.floor(Date.now() / 1000) - 3 * 86_400;
  let replayed = 0;
  for await (const pi of stripe.paymentIntents.list({ created: { gte: since }, limit: 100 })) {
    if (pi.status !== "succeeded" || pi.metadata?.kind !== "topup") continue;
    await handleStripeWebhook({
      id: `sync_${pi.id}`, type: "payment_intent.succeeded", data: { object: pi },
    } as unknown as Stripe.Event);
    replayed++;
  }
  return { replayed };
}
```

Schedule `0 * * * *` with a 30-minute lock. It makes no attempt to work out what was missed; it
replays the last three days and lets the ledger's `(kind, stripeRef)` idempotency absorb the rest.

Route through `handleStripeWebhook`, **not** `dispatchStripeEvent`, so each replay writes a
`WebhookEvent` row and failures surface instead of being swallowed (§14.5).

---

## 12. The client

Stripe Elements with `confirmPayment`. No redirect to Checkout.

```tsx
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: returnUrl },
  redirect: "if_required",     // a plain card stays in-page; only 3DS leaves
});
```

- **The browser is never the source of truth for the balance.** `confirmPayment` resolving means
  the card was accepted, not that the webhook has run.
- After it resolves, poll `GET /billing/credits` every 2.5s for up to 120s. If it never arrives,
  show "this is taking longer than usual, your payment is safe" rather than an error.
  `billing-sync` credits it within the hour.
- Top-up amounts and labels come from `GET /billing/topup-options`. **The client never computes a
  price, an email count or a duration.**
- Generate the idempotency key client-side, keyed by org and amount, in `sessionStorage`, so a
  reload reuses the same payment.
- Cache `loadStripe` per publishable key in a module-level `Map`.
- Add `Idempotency-Key` to the CORS `allowedHeaders` list or the browser blocks the request.
- When `cfg.enabled` is false, render a plain notice. Never a broken form.

The auto-reload switch lives on the credits page, off by default, showing `disabled_reason` when
the system turned it off.

---

## 13. Deployment

**Public URL:** `https://<api-host>/api/v1/billing/webhook`

**Point Stripe at the API host directly, never through a frontend rewrite.** If the web app
proxies `/api/*` through Node, the body can be re-serialised and every signature fails. Set
`API_PROXY=off` in production.

Requirements:

- Valid TLS. Stripe will not deliver to a self-signed or expired certificate in live mode.
- The webhook path reachable without authentication.
- Nothing rewriting the request body in front of the app.
- `app.set("trust proxy", 1)`.

If a reverse proxy sits in front, nothing special is needed, only nothing harmful:

```nginx
location /api/ {
    proxy_pass              http://127.0.0.1:4000;
    proxy_http_version      1.1;
    proxy_set_header        Host              $host;
    proxy_set_header        X-Real-IP         $remote_addr;
    proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header        X-Forwarded-Proto $scheme;
    proxy_request_buffering on;
    client_max_body_size    5m;
    proxy_read_timeout      60s;
}
```

On Cloud Run, `--allow-unauthenticated` is what lets Stripe reach the endpoint. Keep
`--min-instances 1` and `--no-cpu-throttling`.

---

## 14. Defects and dead config to fix

Present in the codebase now. Fix as part of this work.

**14.1 No `apiVersion` pinned.** A dependency bump can silently change API behaviour. Pin it (§3).

**14.2 Dead env vars.** `STRIPE_PRICE_INBOX`, `STRIPE_PRICE_INBOX_FAST`, `INBOX_FAST_PRICE_CENTS`
are declared in `config/env.ts` and read nowhere. Remove all three.

**14.3 Stale test config.** `apps/server/vitest.config.ts` still sets `STRIPE_PRICE_LAUNCH`,
`STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`, `STRIPE_PRICE_INBOX`. Delete those lines.

**14.4 Stale price fixtures.** `apps/client/test/live.test.tsx` carries `"$0.035 per email"`. The
price is now a flat `$0.04`. Grep for `0.035`, `0.045`, `0.025` and `0.03` across both apps and
fix every one.

**14.5 `billing-sync` swallows errors.** It calls `dispatchStripeEvent` directly with
`.catch(() => undefined)`, so replays write no `WebhookEvent` row and failures are invisible.
Change it to `handleStripeWebhook` (§11).

**14.6 The `docs/` folder describes a product that does not exist.** `docs/stripe.md`,
`docs/credits.md`, `docs/api-map.md:78-80`, `docs/deployment.md:45-53` and `README.md:4` all
describe Checkout, subscriptions, `STRIPE_PRICE_LAUNCH/GROWTH/SCALE`, a Billing Portal and
`customer.subscription.*` webhooks. None of it exists. Rewrite to match this spec or delete.
Leaving them is worse than having no docs.

**14.7 The deployment doc lists the wrong events.** It names three `customer.subscription.*`
events. The correct list is the seven in §1.3.

**14.8 Orphan Prisma models.** `Plan` and `Subscription`, with `stripePriceId` and
`stripeSubscriptionId`, are in the schema and no Stripe code touches them. Drop them.

**14.9 Disputes unhandled.** No `charge.dispute.*` handler exists. Add §10.

**14.10 The fixed `TOPUP_OPTIONS` array.** Replace with the validation and derivation in §4.2.

---

## 15. Acceptance criteria

- A forged signature returns 400 and writes zero rows. There is a test.
- The same `payment_intent.succeeded` delivered three times credits exactly once.
- Two different event ids carrying the same PaymentIntent credit exactly once.
- `billing-sync` run twice in an hour credits nothing twice and writes a `WebhookEvent` row per
  replay.
- A balance can never go negative. The CHECK constraint is in the applied migration.
- A double-clicked "Add credits" creates one PaymentIntent, not two.
- A page reload mid-payment resumes the same PaymentIntent.
- A top-up of $37 is accepted; $24 is rejected with the minimum stated; $24.50 is rejected as not
  a whole dollar; $20,000 is rejected with the ceiling stated.
- `GET /billing/topup-options` at a $20 daily budget returns $60 / $140 / $280 / $600 with the
  7-day option flagged recommended, and the email counts are exact at $0.04.
- **With auto-reload off, no charge can occur without the customer pressing a button.** There is a
  test that proves no code path reaches `off_session: true` when `enabled` is false.
- With auto-reload on, at most one charge occurs per org per 24 hours, enforced both by the
  cooldown check and by the dated idempotency key.
- An auto-reload that fails disables auto-reload, writes `disabled_reason`, and emails the
  customer. It is never retried.
- `authentication_required` is handled distinctly from a decline and emails a link.
- Removing the saved card switches auto-reload off.
- `charge.dispute.created` pauses the organization, claws back the unspent balance, and disables
  auto-reload.
- A refund larger than the unspent balance logs a warning and returns 200.
- `grep -ri "price_\|subscription\|checkout.session\|billing.portal" apps/server/src` returns
  nothing outside comments.
- Production refuses to start without `STRIPE_SECRET_KEY`, naming every missing key at once.

---

## 16. Do not do

- Do not add subscriptions, plans, tiers, Stripe Products, Stripe Prices, Checkout Sessions or the
  Billing Portal.
- Do not subscribe to `customer.subscription.*` or `invoice.*` events.
- **Do not use `off_session: true` anywhere except `runAutoReload`**, and not there unless
  `enabled` is true and a mandate is recorded.
- Do not turn auto-reload on by default, do not hide the switch, and do not retry a failed
  auto-reload.
- Do not allow a postpaid or negative balance.
- Do not charge a different price for a follow-up. The price is flat; §4.2's exact email counts
  depend on it.
- Do not accept an arbitrary top-up amount from the client. Validate with §4.2 on the server.
- Do not let the client compute a price, an email count or a duration. Those come from the API.
- Do not parse the request body before verifying the signature.
- Do not put auth, CSRF or a rate limiter in front of the webhook route.
- Do not return 200 when a handler failed.
- Do not keep a mutable balance column.
- Do not use a float for any monetary value. Integer cents at the Stripe boundary, bigint
  deci-cents everywhere inside.
- Do not charge inside the send pipeline. Auto-reload is queued, never inline.
- Do not reuse a test webhook secret in live mode.
- Do not point Stripe at a URL that passes through a frontend proxy.
- Do not remove the customer's ability to delete their card or close their account themselves.
- Do not build from the `docs/` folder. It is stale; §14.6 says fix or delete it.
