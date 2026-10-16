# Stripe billing

Aperture sells prepaid credits at a flat **$0.04 per email**. There are no subscriptions, plans, tiers, Stripe
Products, Stripe Prices, Checkout Sessions, invoices or Billing Portal. The full specification is
`aperture-stripe-spec.md` (v2); this page is the working summary.

```
customer sets a daily budget in dollars    →  the volume control
customer tops up                           →  balance goes up
emails are sent at $0.04 each              →  balance goes down
balance reaches $2                         →  cold email pauses, live conversations keep going
balance hits zero                          →  everything stops
optional auto-reload                       →  tops up again before it runs out
```

## Keys

| Variable | Shape | Where |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` | server only; production refuses to start without it |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` | served to the browser at runtime by `GET /billing/config` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | one per endpoint (test, live and the CLI each have their own) |

The API version is pinned in `apps/server/src/modules/billing/stripe.client.ts` (`STRIPE_API_VERSION`) to the
version the installed SDK is typed against. Upgrade the SDK and the pin together.

## Adding a card (setup)

Setup step 6 saves a card without taking money: `POST /api/v1/billing/setup-intents` with `{ "purpose": "card" }`
creates a SetupIntent with `usage: "on_session"`, confirmed in the page with `stripe.confirmSetup`
(`redirect: "if_required"`). When Stripe reports `setup_intent.succeeded`, the webhook adds the $10 free credit
(ledger ref `trial:<payer>`, so it can only ever be granted once). Nothing is charged during setup, and there is no
other way to take the free credit. "Skip for now" creates the campaign without starting it and gives no credit.

Auto-reload asks for its own consent when it is switched on: `{ "purpose": "auto_reload" }` creates a second
SetupIntent, `usage: "off_session"`, on the saved card, confirmed with `stripe.confirmCardSetup`. The settings change
that switches auto-reload on sends its id, and the server checks it with Stripe before recording the mandate.

## Top-ups

`POST /api/v1/billing/topups` with an `Idempotency-Key` header (`[\w-]{8,100}`, prefixed `topup:` for Stripe) and
`{ "amount": "<deci-cents>" }`. The server validates three rules (`validateTopup` in `domain/money.ts`): whole
dollars, at least $25, at most $10,000. It creates a PaymentIntent confirmed in the page with Stripe Elements
(`confirmPayment`, `redirect: "if_required"`) and returns only the client secret.

- `setup_future_usage` is `on_session`, or `off_session` only when auto-reload is on with a recorded mandate.
- Top-ups happen on the Credits page only, never during setup.
- `metadata`: `organizationId`, `kind: "topup"`, `source: "manual" | "auto_reload"`, `deciCents`. The webhook relies on it.
- Suggested amounts come from `GET /billing/topup-options[?budget=]`: daily budget × {1, 3, 5, 22} sending days (a
  week is 5, a month is 22, everywhere), rounded up to $5, never under $25, the week recommended. At $20 a day:
  $25 / $60 / $100 / $440. The response also carries the lead sentence and the balance in days. The client never
  computes a price, an email count or a duration.
- The balance moves only when the webhook (or the hourly sync) credits the payment. The browser polls
  `GET /billing/credits` every 2.5 s for up to two minutes, then says the payment is safe and will appear.

## Auto-reload

The only off-session charge in the codebase (`modules/billing/autoReload.ts`; a test fails if `off_session: true`
appears anywhere else).

- Off by default. Switching it on records the mandate on `OrgSettings`: the exact sentence shown ("When my balance
  drops below $40, charge my saved card $140. At most one charge a day. I can turn this off at any time."), when,
  which user and from which IP. Changing the numbers records a new mandate.
- After a debit commits, `chargeSend` only enqueues a check (`queueAutoReload`). A send never waits on a card. A
  ten-minute scheduled job (`auto-reload`) is the safety net.
- At most one charge per 24 hours: the slot is claimed in the database before the card is touched, and the Stripe
  idempotency key is dated (`autoreload:<org>:<YYYY-MM-DD>:<mandate time>`).
- Any failure switches it off, writes `autoReloadDisabledReason` and emails the owners. It is never retried.
- `authentication_required` (3-D Secure) is its own case: switched off, and the email links to
  `/app/billing/credits?confirm=<pi>`, where the customer approves the payment in the page.
- It also switches off when the card is removed, a payment is disputed or the account is closed. The credits page
  shows the reason.

## Webhook

`POST /api/v1/billing/webhook` on the public router: no auth, no CSRF, no rate limiter. The raw body is kept by
`express.json({ verify })` for the signature check. Bad signature → 400 and nothing written.

Subscribe to exactly these nine events, and no `customer.subscription.*` or `invoice.*`:

```
setup_intent.succeeded           a card saved at setup: add the free credit, once
setup_intent.setup_failed        record it
payment_intent.succeeded         credit the top-up (idempotent on the PaymentIntent id)
payment_intent.payment_failed    record it; a failed auto-reload switches auto-reload off
payment_intent.processing        record it
payment_intent.requires_action   an auto-reload needs 3-D Secure: off, and email a link
charge.refunded                  claw back the newly refunded part from the unspent balance
charge.dispute.created           mark DISPUTED, claw back, switch auto-reload off, pause sending
charge.dispute.closed            if won: credit it back and resume sending
```

Duplicates are stopped three ways: the unique `(provider, externalId)` on `WebhookEvent`, a unique-violation catch
for racing deliveries, and the ledger's unique `(kind, stripeRef)`. A handler that throws marks the row FAILED and
returns 500 so Stripe retries; FAILED rows are processed again on the next delivery.

`billing-sync` (hourly) replays every succeeded top-up and every card saved at setup from the last three days through `handleStripeWebhook`, so
each replay writes a `WebhookEvent` row and nothing is credited twice.

## Local testing

```bash
stripe login
stripe listen --forward-to localhost:4000/api/v1/billing/webhook   # prints a whsec_ for STRIPE_WEBHOOK_SECRET
stripe trigger payment_intent.succeeded
```

Test card `4242 4242 4242 4242`; `4000 0025 0000 3155` asks for 3-D Secure.

## Deployment

Point Stripe at the API host directly (`https://<api-host>/api/v1/billing/webhook`), never through a frontend
rewrite that could re-serialise the body. Valid TLS, the path reachable without auth, `trust proxy` set.
