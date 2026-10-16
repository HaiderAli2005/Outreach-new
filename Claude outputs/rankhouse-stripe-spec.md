# RankHouse: Stripe billing build specification

You are working on the RankHouse codebase: `server/` is plain JavaScript Express (not TypeScript,
no Prisma), with raw SQL migrations in `migrations/` and `base-schema.sql`, Bull queue for jobs,
and `client/` for the frontend.

## Read these first, in this order

1. **`BILLING-REQUIREMENTS.md` in the repo root is the source of truth for WHAT to build.** Every
   decision in its "Decisions Ali has made" table is binding. Do not re-litigate any of them.
2. This document is the source of truth for **HOW** to build it safely: the Stripe mechanics,
   webhook security, idempotency and the money ledger.

**The two differ on model and that is deliberate.** A reference implementation (the Aperture
codebase) uses prepaid credit top-ups with PaymentIntents and no subscriptions at all. RankHouse
does **not** work that way. Per `BILLING-REQUIREMENTS.md`, RankHouse sells **real Stripe
subscriptions** with admin-created prices, per-client negotiated amounts, add-ons, grace days and
our own dunning. Copy Aperture's engineering patterns below. Do **not** copy its billing model.

---

## 1. Environment variables

```
STRIPE_SECRET_KEY=          # sk_test_... / sk_live_...  SERVER ONLY, never sent to a browser
STRIPE_PUBLISHABLE_KEY=     # pk_test_... / pk_live_...  safe in a browser
STRIPE_WEBHOOK_SECRET=      # whsec_...  one per endpoint; test, live and CLI each have their own
STRIPE_DEFAULT_CURRENCY=usd
```

Validate at boot and fail fast, naming every missing key at once rather than dying at the first
API call. In production, refuse to start without `STRIPE_SECRET_KEY`. In development, warn and
let billing endpoints return `503 NOT_CONFIGURED`.

Never expose the publishable key as a build-time variable baked into the bundle. Serve it at
runtime from `GET /api/v1/billing/config`, which returns:

```json
{ "enabled": true, "publishableKey": "pk_test_..." }
```

That way one build works in test and in live.

## 2. Stripe client

One lazily-created singleton, plus a separate throwaway client used only for signature
verification (verification is pure cryptography and does not need a live key, so webhooks can be
tested without one).

```js
// server/services/stripe/client.js
const Stripe = require("stripe");

let cached;
let override; // test seam

function getStripe() {
  if (override !== undefined) return override;
  if (cached === undefined) {
    cached = process.env.STRIPE_SECRET_KEY
      ? new Stripe(process.env.STRIPE_SECRET_KEY, {
          maxNetworkRetries: 2,
          appInfo: { name: "RankHouse" },
        })
      : null;
  }
  return cached;
}

function requireStripe() {
  const s = getStripe();
  if (!s) { const e = new Error("Billing is not configured"); e.status = 503; throw e; }
  return s;
}

let verifier;
function webhookVerifier() {
  verifier ??= new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_verification_only");
  return verifier;
}

function setStripeClient(c) { override = c; }   // tests inject a fake or null

module.exports = { getStripe, requireStripe, webhookVerifier, setStripeClient };
```

Set `maxNetworkRetries: 2`. Do not pin an `apiVersion` unless you are prepared to maintain it.

---

## 3. Packages and prices

`BILLING-REQUIREMENTS.md` decides the shape; this section says how it maps onto Stripe.

### 3.1 The mapping

```
RankHouse "package" (plans row)   →  Stripe Product
RankHouse price version            →  Stripe Price
```

**Stripe prices are immutable.** You cannot edit the amount on an existing Price. This is
convenient, because it matches the decision already made: *"Changing a price = a new price
version; clients on the old one stay on it."* Stripe enforces that for you.

So "edit the price of a package" means: create a new Stripe Price, mark the old `plan_prices` row
retired from sale, leave every existing subscription pointing at the old Price.

### 3.2 Creating them from the admin panel

The admin types an amount; the backend mints the Stripe objects. Never pre-create prices in a
migration or a seed.

```js
// first time a package is created
const product = await stripe.products.create(
  { name: pkg.name, metadata: { planId: pkg.id } },
  { idempotencyKey: `plan:${pkg.id}:product` }
);

// each price version
const price = await stripe.prices.create(
  {
    product: product.id,
    unit_amount: amountInCents,          // integer cents, never a float
    currency: currency.toLowerCase(),
    ...(interval
      ? { recurring: { interval, interval_count: intervalCount } }
      : {}),                              // omit recurring entirely for Lifetime
    metadata: { planId: pkg.id, version: String(nextVersion) },
  },
  { idempotencyKey: `plan:${pkg.id}:price:${nextVersion}` }
);
```

### 3.3 "Any duration"

The decision is any billing cycle, not just monthly and yearly. Stripe expresses that as
`interval` plus `interval_count`:

| UI cycle | Stripe |
|---|---|
| Weekly | `{ interval: "week", interval_count: 1 }` |
| Monthly | `{ interval: "month", interval_count: 1 }` |
| Yearly | `{ interval: "year", interval_count: 1 }` |
| Custom, e.g. every 3 months | `{ interval: "month", interval_count: 3 }` |
| Lifetime | **no `recurring` at all** — a one-time Price, charged through a PaymentIntent, not a Subscription |

Limits to enforce in the form: `interval_count` max 1 for year, 12 for month, 52 for week,
365 for day. Stripe rejects anything beyond that, so validate before calling.

### 3.4 Credits

Per the decision, credits live on the package as a **monthly** figure (`plans.credits`), never on
a price. A yearly price on a 2,000-credit package still grants 2,000 a month.

So the credit grant is driven by the **billing period**, not the invoice amount:

```
on invoice.paid for a yearly subscription:
    grant plans.credits now
    schedule the same grant on each monthly anniversary for the next 11 months
```

Implement the monthly grant as a job, not as a webhook side effect, because for a yearly plan
only one invoice ever arrives. See §8.

---

## 4. Assigning a package (creating the subscription)

Endpoint: `POST /api/v1/admin/clients/:orgId/subscription`, operator only.

Requires an `Idempotency-Key` header matching `/^[\w-]{8,100}$/`; reject with 400 if absent. Pass
it through to Stripe prefixed, so a double-click never creates two subscriptions.

```js
const customerId = await ensureCustomer(orgId, email);

const sub = await stripe.subscriptions.create(
  {
    customer: customerId,
    items: [{ price: priceId, quantity: qty }, ...addonItems],
    collection_method: "charge_automatically",   // or "send_invoice" for invoiced clients
    ...(collectionMethod === "send_invoice" ? { days_until_due: daysUntilDue } : {}),
    proration_behavior: "create_prorations",
    metadata: { organizationId: orgId, planId, assignedBy: adminId },
  },
  { idempotencyKey: `sub:${orgId}:${idempotencyKeyHeader}` }
);
```

**Negotiated amounts.** When the admin types an amount that no existing Price matches, mint a new
Price for it first (§3.2) and mark it `negotiated: true` in metadata so it never appears on the
public pricing wall.

**One plan per account.** Before creating, check for an existing active subscription. If there is
one, do **not** create a second; call `stripe.subscriptions.update` to change its items. The
decision is explicit: *"A subscriber never checks out a second subscription; they switch the one
they have."*

**Customer object:**

```js
async function ensureCustomer(orgId, email) {
  const org = await db.one("SELECT id, name, stripe_customer_id FROM organizations WHERE id=$1", [orgId]);
  if (org.stripe_customer_id) return org.stripe_customer_id;
  const c = await requireStripe().customers.create(
    { email, name: org.name, metadata: { organizationId: orgId } },
    { idempotencyKey: `org:${orgId}:customer` }
  );
  await db.none("UPDATE organizations SET stripe_customer_id=$1 WHERE id=$2", [c.id, orgId]);
  return c.id;
}
```

`organizations.stripe_customer_id` must be **UNIQUE**. That index is what lets the webhook map a
Stripe customer back to an org.

---

## 5. The webhook — the most important part of this spec

Most Stripe bugs live here. Follow this exactly.

### 5.1 The raw body problem

`express.json()` parses the body and throws the original bytes away. Stripe's signature is
computed over those exact bytes. Parse-then-reserialise produces different bytes and every
signature check fails.

Capture the raw bytes for that one path only:

```js
// server/index.js — BEFORE any route is mounted
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      if (req.originalUrl && req.originalUrl.startsWith("/api/v1/billing/webhook")) {
        req.rawBody = Buffer.from(buf);
      }
    },
  })
);
app.set("trust proxy", 1);   // required behind nginx
```

An alternative is `express.raw({ type: "application/json" })` mounted on the webhook path before
`express.json()`. Either works. The `verify` hook is less fragile because route ordering cannot
break it.

### 5.2 The route

Mount on a **public, unauthenticated** router. Stripe cannot log in. Do not put auth middleware,
CSRF, or an API-key check in front of it; the signature is the authentication.

```
POST /api/v1/billing/webhook
```

Do not rate-limit it. Stripe retries aggressively and a 429 looks like an outage.

### 5.3 Signature verification

```js
function verifyStripeEvent(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw badRequest("Webhook secret not configured");
  if (!rawBody || !signature) throw badRequest("Missing Stripe signature");
  try {
    return webhookVerifier().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw badRequest("Invalid Stripe signature");
  }
}
```

A bad signature returns **400** and writes **nothing** to the database. There must be a test that
asserts the row count is unchanged after a forged request.

### 5.4 Duplicate protection

Stripe delivers the same event more than once. That is normal, not an error.

```sql
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  external_id   text NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'RECEIVED',  -- RECEIVED|PROCESSED|IGNORED|FAILED
  error         text,
  processed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
```

```js
async function handleStripeWebhook(event) {
  let row = await findEvent("STRIPE", event.id);
  if (row && row.status !== "FAILED") return { duplicate: true };   // FAILED rows DO get retried
  if (!row) {
    try { row = await insertEvent("STRIPE", event.id, event.type, event); }
    catch (e) { if (isUniqueViolation(e)) return { duplicate: true }; throw e; }
  }
  try {
    const handled = await dispatchStripeEvent(event);
    await markEvent(row.id, handled ? "PROCESSED" : "IGNORED");
    return { duplicate: false };
  } catch (err) {
    await markEvent(row.id, "FAILED", err.message.slice(0, 1000));
    throw err;    // rethrow: a 500 makes Stripe retry
  }
}
```

Three layers, and you need all three:

1. The unique `(provider, external_id)` index short-circuits a repeat.
2. The unique-violation catch handles two deliveries racing on the insert.
3. The ledger itself is idempotent on the Stripe object id, so even a *different* event carrying
   the same invoice grants credit once (§7).

### 5.5 Status codes

```
200  processed, or a duplicate            → Stripe stops retrying
400  bad signature, missing raw body      → nothing written, Stripe stops
500  handler threw                        → Stripe retries with backoff
```

Never return 200 on a handler failure to "keep Stripe happy". The retry is the recovery mechanism.

### 5.6 Events to handle

RankHouse is subscription-based, so the event set differs from a prepaid product.

```js
switch (event.type) {
  // the subscription's own lifecycle
  case "customer.subscription.created":
  case "customer.subscription.updated":
  case "customer.subscription.deleted":
    await onSubscription(event.data.object); return true;

  // money
  case "invoice.paid":                 await onInvoicePaid(event.data.object);     return true;
  case "invoice.payment_failed":       await onInvoiceFailed(event.data.object);   return true;
  case "invoice.payment_action_required": await onActionRequired(event.data.object); return true;
  case "invoice.finalized":
  case "invoice.updated":              await upsertInvoice(event.data.object);     return true;

  // one-time payments (Lifetime packages)
  case "payment_intent.succeeded":     await onPaymentSucceeded(event.data.object); return true;
  case "payment_intent.payment_failed":await upsertPayment(event.data.object, "FAILED"); return true;

  // money going back out
  case "charge.refunded":              await onChargeRefunded(event.data.object);  return true;
  case "charge.dispute.created":       await onDisputeOpened(event.data.object);   return true;
  case "charge.dispute.closed":        await onDisputeClosed(event.data.object);   return true;

  default: return false;   // recorded as IGNORED, still returns 200
}
```

`invoice.paid` is the event that grants credits and extends access. **Not**
`customer.subscription.created`, and **not** `checkout.session.completed`. A subscription can
exist without anyone having paid. Only `invoice.paid` means money arrived.

`charge.dispute.created` matters and the reference implementation does not handle it. A dispute
means the money is gone and the bank is deciding. Suspend the account's access and alert an
operator; do not wait for `dispute.closed`.

---

## 6. Dunning and grace, our own

The decision is explicit: *"our own dunning/reminders"*, with configurable grace days.

```
invoice.payment_failed arrives
   → mark the subscription PAST_DUE
   → start the grace clock (plans/settings default grace days, overridable per client)
   → day 1   email the client
   → day 3   email again
   → day 7   final notice
   → grace expires → BLOCKED: no app access, data retained, operator can lift it

invoice.paid arrives at any point
   → clear PAST_DUE, cancel the remaining reminders, restore access immediately
```

Let Stripe do its own smart retries as well; the two are complementary. Our reminders are about
telling the human, Stripe's are about retrying the card.

Never auto-cancel a subscription on failure. Blocking access is reversible; cancelling is not, and
it loses the price version the client was on.

---

## 7. The credit ledger

Copy this pattern from the reference exactly. It is the part that prevents money bugs.

```sql
CREATE TABLE credit_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial UNIQUE,              -- strict insert order
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           text NOT NULL,                  -- GRANT|SPEND|REFUND|BONUS|CORRECTION
  amount         bigint NOT NULL,                -- positive credit, negative debit
  balance_after  bigint NOT NULL,
  stripe_ref     text,                           -- invoice id, PI id, refund id
  period_key     text,                           -- 'YYYY-MM' for a monthly grant
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_balance_nonneg CHECK (balance_after >= 0)
);

CREATE UNIQUE INDEX ON credit_ledger (kind, stripe_ref) WHERE stripe_ref IS NOT NULL;
CREATE UNIQUE INDEX ON credit_ledger (organization_id, kind, period_key) WHERE period_key IS NOT NULL;
CREATE INDEX ON credit_ledger (organization_id, created_at DESC);
```

Rules, all of them load-bearing:

- **There is no mutable balance column.** The balance is the `balance_after` of the newest row.
  A column that is updated will drift from the ledger and you will never find out why.
- **Every write holds a per-customer advisory lock inside the transaction:**

```js
async function withCustomerLock(orgId, fn) {
  return db.tx(async (t) => {
    await t.none("SELECT pg_advisory_xact_lock(hashtext($1))", [`credits:${orgId}`]);
    return fn(t);
  });
}
```

  The duplicate check and the insert must be in the **same** transaction under that lock.
  Check-then-insert without it is a race that double-credits under concurrent webhooks.
- **The two unique indexes are the real guarantee.** `(kind, stripe_ref)` means one invoice grants
  once even if the lock fails. `(organization_id, kind, period_key)` means a monthly grant lands
  once per month even if the job runs twice.
- **The CHECK constraint** is the final floor. A balance can never go below zero at the database
  level, whatever the application does.

### Granting monthly credits

```js
// on invoice.paid: grant for the current period
await grantCredits(orgId, plan.credits, {
  ref: invoice.id,
  periodKey: yyyymm(new Date()),
  note: `${plan.name} monthly credits`,
});

// a daily job grants the in-between months of a long billing interval
// idempotent on (organization_id, 'GRANT', period_key), so running it twice is harmless
```

---

## 8. Reconciliation

Webhooks get lost: a deploy during delivery, a timeout, a bad release. Run a job that replays.

```js
// hourly
async function runBillingSync() {
  const stripe = getStripe();
  if (!stripe) return { skipped: "stripe-not-configured" };
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  let seen = 0;
  for await (const inv of stripe.invoices.list({ created: { gte: since }, status: "paid", limit: 100 })) {
    await dispatchStripeEvent({ id: `sync_${inv.id}`, type: "invoice.paid", data: { object: inv } })
      .catch(() => undefined);
    seen++;
  }
  return { seen };
}
```

It does not try to work out what was missed. It replays everything from the last three days and
lets the ledger's idempotency absorb what was already handled. That is simpler and safer than
tracking gaps.

Run it on Bull with a repeat rule and a lock so two workers cannot run it at once.

A second daily job reconciles subscription **state**: list active Stripe subscriptions, compare
with the local table, log any disagreement. Do not auto-correct; a mismatch is a bug to look at.

---

## 9. Client side

Use **Stripe Elements with `confirmPayment`**, not a redirect to Checkout. It keeps the customer
on RankHouse and matches the panel's look.

```js
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: `${window.location.origin}/app/billing?paid=1` },
  redirect: "if_required",       // a plain card stays in-page; only 3DS leaves
});
```

Then:

- **Never trust the browser for the balance or the subscription state.** `confirmPayment`
  resolving means the card was accepted, not that the webhook has run.
- After it resolves, poll `GET /api/v1/billing/status` every 2.5 seconds for up to 120 seconds
  until the server reports the new state, then stop. If it never arrives, show "this is taking
  longer than usual, your payment is safe" rather than an error. The hourly sync will fix it.
- Load Stripe.js once per publishable key and cache the promise.
- Generate the `Idempotency-Key` on the client, store it in `sessionStorage` keyed by org and
  amount, and reuse it on reload so a refresh does not start a second payment.
- Add `Idempotency-Key` to the CORS `allowedHeaders` list or the browser will block it.

---

## 10. nginx

Nothing clever is needed. The risk is doing something that alters the body.

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

Requirements:

- **Valid TLS.** Stripe will not deliver to a self-signed or expired certificate in live mode.
- **No auth, no IP allowlist, no basic auth** on the webhook path.
- **No body-rewriting module** (`sub_filter`, `gzip` on the request, any Lua that reads the body).
- `client_max_body_size` at least 2m. Stripe events are usually under 100KB but can be larger.
- `app.set("trust proxy", 1)` in Express so `req.ip` and `X-Forwarded-Proto` are honoured.
- Point Stripe at the **API host directly**. If a Next.js or other Node layer proxies `/api/*`,
  the body may be re-serialised and every signature will fail.

---

## 11. Build order

```
1.  env validation + stripe client + /billing/config          (§1, §2)
2.  webhook_events table + raw body capture + signature check  (§5.1-5.5)
3.  credit_ledger table, advisory lock, grant/spend            (§7)
4.  webhook dispatch for invoice.paid only, end to end         (§5.6, §7)
5.  product + price creation from the admin panel              (§3)
6.  assign package → subscription create/update                (§4)
7.  the remaining webhook events                               (§5.6)
8.  dunning, grace, block/unblock                              (§6)
9.  refunds and disputes                                       (§5.6)
10. billing-sync and state reconciliation jobs                 (§8)
11. client Elements flow + polling                             (§9)
12. nginx and the production webhook endpoint                  (§10)
```

Items 2, 3 and 4 before anything else. A working, idempotent, locked money path with one event is
worth more than ten event handlers on a path that double-credits.

---

## 12. Acceptance criteria

- A forged signature returns 400 and writes zero rows. There is a test.
- The same `invoice.paid` event delivered three times credits exactly once.
- Two different events carrying the same invoice id credit exactly once.
- The monthly grant job run twice in one day grants once.
- A balance can never go negative; the CHECK constraint is in the applied migration, not only in
  application code.
- A double-clicked "Assign package" creates one subscription, not two.
- Editing a package price creates a new Stripe Price; existing subscribers stay on the old one.
- A yearly subscription grants credits every month, not once a year.
- `invoice.payment_failed` starts the grace clock; `invoice.paid` during grace restores access
  immediately and cancels pending reminders.
- No package, plan or price exists that an admin did not create.
- Test and live mode each have their own webhook endpoint and their own signing secret.

---

## 13. Do not do

- **Do not seed packages, plans, prices or demo clients.** Not even for testing. This is rule 1 in
  `BILLING-REQUIREMENTS.md` and it has been broken before. Create them from the admin panel.
- Do not change anything outside what was asked. Rule 2: swap the named thing, leave the rest
  pixel-identical.
- Do not put a float anywhere near money. Integer cents for Stripe, bigint for the ledger.
- Do not keep a mutable `balance` column.
- Do not grant credits on `customer.subscription.created` or `checkout.session.completed`. Only
  `invoice.paid` means money arrived.
- Do not return 200 when a handler failed. Let Stripe retry.
- Do not put authentication, CSRF or rate limiting in front of the webhook route.
- Do not parse the body before verifying the signature.
- Do not charge a saved card off-session without an explicit mandate. Subscription renewals are
  fine because the subscription is the mandate; ad-hoc charges are not.
- Do not auto-cancel a subscription on a failed payment. Block access instead.
- Do not reuse a test webhook secret in live mode. They are different values.
- Do not hardcode a price id anywhere. All prices come from the database, which got them from
  Stripe at creation time.
- Do not build from the reference project's `docs/` folder if you are shown it; that folder
  describes a subscription model its own code no longer uses and is known to be stale.
