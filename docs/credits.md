# Credits and money

Every amount is a bigint count of **deci-cents** (tenths of a cent): $1.00 = 1000. Floats never hold money. Amounts
become display strings only at the API boundary (`formatUsd`). Stripe sees integer cents (`toStripeCents`).

| What | Value | Where |
|---|---|---|
| Every email (first or follow-up) | $0.04 (40) | `PRICE_PER_EMAIL`, `domain/money.ts` |
| A reply to someone who wrote back | $0.04 (40), the same flat price | `COSTS["email.reply"]` |
| Reply reserve | $2: cold email never spends it; replies can spend to $0 | `REPLY_RESERVE` |
| Free trial | $10, exactly 250 emails, once per payer | `FREE_TRIAL_DECICENTS`, ref `trial:<payer>` |
| Top-ups | whole dollars, $25 to $10,000 | `validateTopup` |
| Daily budget | $0 (paused) or $4 to $200 | `OrgSettings.dailyBudgetDecicents` |

Because the price is flat, every figure is exact: $20 a day is 500 emails (125 new people on a 4-email sequence), a
$140 top-up is 3,500 emails.

## The ledger

`CreditLedger` is append-only. There is no balance column: the balance is the `balanceAfter` of the newest row by
`seq`. Writes run under a per-payer Postgres advisory lock. Two database guarantees: a unique index on
`(kind, stripe_ref)` and `CHECK (balance_after >= 0)`, so a balance can never go negative.

## Holds

Starting a person reserves their sequence (4 × $0.04 = $0.16), or as many whole emails as the balance still covers,
so a balance is spent to the cent. Each accepted email turns $0.04 of the hold into a charge; a bounce is never
charged. A reply, unsubscribe or stop releases what is left. Stale holds are released after 30 days.

## The reply reserve

Cold email (first emails and follow-ups) never spends the last $2 of a balance. A reply to someone who wrote back
(a human reply on record; an out-of-office never counts) may spend down to zero. So:

| Balance | What sends | Code when refused |
|---|---|---|
| over $2 | everything | |
| $2 or less | replies in live conversations only | cold email `COLD_EMAIL_PAUSED` |
| $0 | nothing | `INSUFFICIENT_CREDITS` |

## The daily budget

The only volume control. Emails a day = budget / $0.04. `budgetGuard` refuses new sends once today's spend would
pass the budget; $0 pauses everything except replies, without touching the balance. The dashboard card shows
today's spend against the budget and, only when the budget is spent and people are queued, offers to raise it,
with the reply rate measured over the last 30 days.

## Shared billing

`Organization.billingOrganizationId` makes one organisation pay for another's workspace (`customerOf`).
