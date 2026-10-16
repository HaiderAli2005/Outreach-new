# Aperture spec 5: onboarding, credits and the Cockpit

Replaces **spec 4 §3 and §4**. Everything else in spec 4 stands: flat $0.04 an email, prepaid,
auto-reload off by default.

This revision makes two changes that between them remove most of the confusion in the current
flow:

1. **Ask for emails a day, not dollars a day.**
2. **The free credit is unlocked by adding a card, and nothing is charged.**

---

## 0. Why these two changes fix so much

### 0.1 Volume, not budget

At a flat $0.04, "500 emails a day" and "$20 a day" are two spellings of one number. So the only
question is which spelling the customer can answer.

```
"How many emails a day?"   answerable from their own business
"What's your budget?"      not answerable until we say what it buys
```

Budget-first makes them guess at a number whose meaning we then reveal. Volume-first is the
natural order.

The **dashboard** control stays in dollars. By then they know the exchange rate, and a budget is a
better ongoing throttle. Different question, different moment.

### 0.2 Card to unlock the free credit

Today there are two paths out of the credits step: take the free credit and skip payment, or pay.
That branch is the direct cause of almost every problem on these screens:

```
step 6 sits incomplete behind a live campaign
step 7 ticks before payment
"Add credits" appears after the thing it was meant to enable
the balance runs out with no card on file, so sending just stops
"running low" fires on a customer who has not sent an email yet
```

**One linear path removes all of it.** The customer adds a card, the free credit is granted,
nothing is charged, and from then on topping up is one tap because the card is already there.

This is what the market leader does: free credits, card required to unlock, not charged.

### 0.3 And it must not become their dark pattern

The same competitor's worst reviews are about billing: *"they keep charging even when you stop
campaigns"*, *"there is no way of cancelling the credit card once added"*.

So copy the mechanic and invert the trust:

```
say plainly, on the card screen, that nothing will be charged
remove-card is one click, visible from day one, never hidden in support
never charge automatically when the free credit runs out,
   unless auto-reload was explicitly switched on
```

Same convenience, none of the trap. That contrast is worth putting on the pricing page.

---

## 1. Step 5: "How many emails a day?"

```
┌────────────────────────────────────────────────────────┐
│      500                                               │
│      emails a day                                      │
│                                                        │
│      [────────●─────────────────────────────]          │
│      100            1,000          2,500      5,000    │
│                                                        │
│   [ 250 ]  [ 500 ]  [ 1,000 ]  [ 2,500 ]  [ 5,000 ]    │
│   ────────────────────────────────────────────────     │
│   $20 a day  ·  125 new people a day  ·  $440 a month  │
└────────────────────────────────────────────────────────┘
```

**Emails is the big number. Cost is the small line underneath.**

> Every email is **$0.04**, including finding the person, verifying the address and writing it.
> Replies are free. Sending, warmup and deliverability are on us. Change this any time from your
> dashboard.

### 1.1 The derived line

All exact, because the price is flat:

```
cost per day      = emails_per_day × 40n deci-cents
new people a day  = emails_per_day ÷ TOUCHES_PER_PERSON   (4)
cost per month    = cost per day × WORKING_DAYS_PER_MONTH (22)
```

### 1.2 Storage

No new column. `projects.daily_budget_decicents` stays the single source of truth:

```ts
daily_budget_decicents = BigInt(emailsPerDay) * PRICE_PER_EMAIL;
```

Volume is the input at signup, the budget is the stored value, the dashboard edits the budget.

### 1.3 The cap is capacity, not the slider's maximum

Currently the slider runs to 5,000 and **recommends** 5,000, while the pool has zero domains. The
product is selling what it cannot deliver.

```
available       = pool daily capacity − committed to other customers
slider maximum  = available, rounded down to the nearest preset
```

Presets above `available` are **disabled with a reason**, not hidden:

```
[ 250 ]  [ 500 ]  [ 1,000 ]  [ 2,500 ]  [ 5,000 ]
                              ────────   ────────
                              more capacity in about 3 weeks
```

With zero capacity, step 5 shows no slider at all:

```
We're getting your sending capacity ready.
Your first domains are warming up and will be live on 12 November.
We'll email you the moment you can start.
[ Notify me ]
```

Honest and recoverable. A live campaign with nothing behind it is neither.

### 1.4 The recommendation

Never recommend the maximum. It reads as greedy and right now it is also undeliverable.

```
recommended = min(
   available capacity,
   reachable market ÷ 90 days ÷ 4 touches × 4,
   1,000
)
```

A first campaign at 250 to 500 a day that works beats 5,000 a day that burns the pool.

---

## 2. Step 6: "Add your card" (was "Add credits")

The whole step changes. **No amount is chosen here.** The customer adds a card, the free credit
lands, nothing is charged.

```
┌──────────────────────────────────────────────────────────────┐
│  Add your card                                               │
│                                                              │
│  Add a card and we'll put $10.00 of free credit in your       │
│  balance, about 250 emails. Nothing is charged today.        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Card details                             Test mode    │  │
│  │  [ Card number ]  [ MM/YY ]  [ CVC ]  [ Country ]       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  🔒 We won't charge this card. Your bank may show a           │
│     temporary $0.00 check, which disappears on its own.      │
│     You can remove the card any time from Credits.           │
│                                                              │
│                        [ Add card and start → ]              │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Use a SetupIntent, not a PaymentIntent

**This is a change to the Stripe spec.** Version 2 of that document says PaymentIntent only, no
SetupIntent. That was written when the only way to add a card was to pay with it. Now there is a
step that saves a card without taking money, which is exactly what a SetupIntent is for.

```ts
const si = await stripe.setupIntents.create(
  {
    customer: customerId,
    usage: "on_session",          // see 2.2
    automatic_payment_methods: { enabled: true },
    metadata: { organizationId: orgId, kind: "onboarding_card" },
  },
  { idempotencyKey: `setup:${orgId}:${idempotencyKeyHeader}` },
);
return { clientSecret: si.client_secret };
```

Client side it is `stripe.confirmSetup` rather than `confirmPayment`, with the same Elements
instance and the same `redirect: "if_required"`.

### 2.2 `on_session`, deliberately

```
on_session    this card may be charged when the customer is present and presses a button
off_session   this card may be charged while they are away
```

At signup we only promise the first. Taking an off-session mandate from someone who has not asked
for auto-reload is over-reaching, and it is the exact behaviour the competitor is criticised for.

When the customer later switches auto-reload on, that is a **second, separate SetupIntent** with
`usage: "off_session"` and the mandate text from the Stripe spec §7.1. One extra confirmation, at
the moment they ask for recurring charges. That is the honest place for it.

### 2.3 Grant the free credit on success

```
setup_intent.succeeded
   → claimTrial(orgId)
   → credit(payer, "BONUS", FREE_TRIAL_DECICENTS, { ref: `trial:${payer}` })
```

The deterministic ref means it can only ever be granted once, however many times the event
arrives.

Add `setup_intent.succeeded` and `setup_intent.setup_failed` to the webhook event list and to the
dashboard subscription. That takes it from seven events to nine.

### 2.4 Handle the cases

```
card declines on setup        → "that card was declined, try another"
3D Secure required            → confirmSetup handles it, redirect: "if_required"
customer has no card at all   → see 2.5
```

### 2.5 The one escape hatch

Some people genuinely cannot add a card at that moment. Do not trap them.

```
Can't add a card right now?  Skip for now
```

Small text link, not a button. Skipping means **no free credit** and the campaign is created but
not launched, with a clear banner: "Add a card to start sending." That keeps one happy path
without blocking anyone.

### 2.6 Top-ups move to the Credits page

The `$60 / $140 / $280 / $600` cards leave onboarding entirely. They belong on `/app/billing/credits`,
where a customer goes when they want more, and where the sentence linking them to the budget makes
sense:

```
500 emails a day costs $20 a day. How long do you want to run?

[ 1 day  $25 ]  [ 3 days  $60 ]  [ 1 week  $100 ]  [ 1 month  $440 ]
   625 emails      1,500            2,500             11,000
                                      ★

You have $10.00 left, about half a day.
```

Four rules for those cards:

**State the link.** "500 emails a day costs $20 a day" turns four mystery numbers into an obvious
answer. Its absence is what made the current screen unreadable.

**One definition of a month.** Step 5 currently says "$440 a month" and step 6 offers "1 month
$600". That is 22 working days against 30 calendar days, one screen apart. Use **working days
everywhere**: a week is 5 sending days, a month is 22.

```
1 day   = daily_budget × 1, floored at $25
3 days  = daily_budget × 3
1 week  = daily_budget × 5
1 month = daily_budget × 22
```

**A low entry point.** The cheapest visible card is at most $25. Do not make someone hunt for the
"another amount" box to spend small.

**The balance in the same unit.** "You have $10.00 left, about half a day", not "about 250 emails",
so it compares directly with the cards.

Server-side validation is unchanged from the Stripe spec §4.2: whole dollars, minimum $25, maximum
$10,000, amounts served by `GET /billing/topup-options`.

---

## 3. The flow, end to end

```
step 5   How many emails a day?     500 → $20 a day
step 6   Add your card              card saved, $10 free credit, nothing charged
step 7   Campaign start             live
```

Three steps, one path, no branch. Step 7 can only ever be reached through step 6.

Today step 7 ticks while the customer is still on step 6, because the free-credit path bypassed
it. With one path that cannot happen.

Launch refuses, with its own message for each, when:

```
daily budget is 0
balance is 0
pool capacity is 0
no card and no credit
```

---

## 4. The Cockpit repeats the onboarding, and loses the answer

"Go to your dashboard" lands on a Cockpit whose largest element is **the same control the customer
just filled in**.

### 4.1 The bug: the saved value is not read

```
onboarding step 5:   Daily budget   $20 a day   ✓   (saved, ticked)
cockpit:             Daily budget   $200 a day      (slider at maximum)
```

**The customer chose $20 and the dashboard shows $200.** Ten times what they asked for, on a $10
balance.

The slider is defaulting to its own maximum instead of reading `daily_budget_decicents`. If that
render also writes back, the customer's choice has been silently replaced with the most expensive
setting in the product. Establish which, and fix it before anything else on this page.

The earlier "$0 a day" state has the same cause: the control is not bound to the stored value in
either direction.

### 4.2 The dashboard asks instead of answering

Someone who has just pressed "Start my campaign" is asking **"is it working?"**. The page answers
with a slider and a warning:

```
1. "Your balance is running low: $10.00"     a warning, before anything happened
2. Sending · 0 / 5,000                       a progress bar at zero
3. DAILY BUDGET $200 A DAY  [slider]         the biggest element, already answered
4. Today $0 of $200 · 0 sent · 0 people
5. Balance $10.00  [Top up]                  the third ask for money on one screen
```

Three ways to give money (header chip, banner button, Top up button) and nothing about the work
just started.

### 4.3 Demote the budget, promote the work

One line, expanding on click:

```
Sending 500 a day · $20 a day · 09:00–17:00            [ Change ]
```

And before the first send, a progress state rather than an empty chart:

```
┌──────────────────────────────────────────────────────┐
│  ◐  Finding your first people                        │
│     412 found · 180 verified · first emails at 09:00 │
│                                                      │
│  Your sequence, audiences and senders are all ready. │
│  Nothing else is needed from you.                    │
└──────────────────────────────────────────────────────┘
```

Once mail flows, that slot fills with sent, delivered, bounce rate and replies. Same place,
results instead of reassurance.

### 4.4 Three balance states, not one

"Your balance is running low" is the first sentence a brand new customer reads.

```
free credit claimed, nothing sent yet
   → not a warning, a fact:
     "Your $10 free credit covers about 250 emails. Add credits when you're ready."

under 2 days of budget, after sending started
   → a warning

zero
   → a blocker
```

### 4.5 One ask, not three

Keep the header chip showing the balance, which opens the top-up panel. The banner appears only in
the warning and blocked states above. Remove the duplicate Top up button.

### 4.6 Say where the clock is

```
Friday, October 9 · 09:00–17:00 · Europe/London
```

Europe/London was never asked for and never chosen. Spec 3 §E.3 schedules sends in the
**prospect's** timezone. Either state the rule in words ("we send in each prospect's local
morning") or let the customer pick. Do not display a timezone nobody selected.

### 4.7 Capacity again

```
Sending   Sent today 0 / 5,000
```

Five thousand a day against zero domains, with the status reading "Finding, writing and sending on
schedule". The capacity check from §1.3 gates the dashboard status too.

---

## 5. Two small bugs on the current screens

**The balance card is clipped.** Bottom left reads `ut 250 emails.` instead of `about 250 emails.`

**Launch does not check the budget.** A campaign reached "Live · sending today" with the budget at
`$0 a day`, which means paused.

---

## 6. Acceptance criteria

### Onboarding

- Step 5 asks for emails a day, with the emails figure as the largest element.
- Picking 500 shows exactly `$20 a day`, `125 new people a day`, `$440 a month`.
- The slider maximum equals available pool capacity; higher presets are disabled with a reason and
  a date.
- With zero capacity there is no slider, and the campaign cannot launch.
- The recommended preset is never the maximum.
- Step 6 collects a card via SetupIntent and charges nothing. There is a test asserting no
  PaymentIntent is created during onboarding.
- `setup_intent.succeeded` grants the free credit exactly once, however many times it is delivered.
- The card is saved `on_session`. No `off_session` mandate exists until auto-reload is switched on.
- "Skip for now" creates the campaign without launching it and grants no credit.
- Step 7 cannot be reached without completing step 6.
- Launch refuses at zero budget, zero balance, zero capacity, or no funding, each with its own
  message.

### Credits page

- The top-up cards are preceded by a sentence naming the volume and the daily cost.
- At a $20 budget the cards are $25 / $60 / $100 / $440 for 1 day / 3 days / 1 week / 1 month.
- A week is 5 sending days and a month is 22 everywhere. `grep` finds no 30-day month in pricing.
- The cheapest card is visible without scrolling and is at most $25.
- The remaining balance is shown in days.
- Remove-card is reachable in one click and is never hidden behind support.

### Cockpit

- The budget reads `daily_budget_decicents`. Setting $20 in onboarding shows $20 here. There is a
  test that sets a value, loads the Cockpit, and asserts it matches.
- Rendering the Cockpit never writes the budget back.
- The budget is a summary line until the customer opens it.
- Before the first send, the top of the page shows progress, not an empty chart.
- A customer who has only claimed the free trial sees a neutral statement, not a warning.
- There is exactly one top-up affordance in the default state.
- No timezone is displayed that the customer did not choose, unless the copy explains the rule.
- The status cannot read "sending on schedule" when capacity is zero.

---

## 7. Do not do

- Do not ask for a budget in dollars at signup. Ask for emails and show the cost.
- Do not change the dashboard control's unit. That one stays in dollars.
- Do not default any control to its maximum. Read the stored value; if there is none, use the
  recommendation from §1.4.
- Do not let the slider exceed available capacity, and do not recommend the maximum.
- Do not take an `off_session` mandate at signup. `on_session` until auto-reload is chosen.
- Do not charge anything during onboarding. The free credit is unlocked by the card, not bought.
- Do not charge automatically when the free credit runs out, unless auto-reload was switched on.
- Do not hide card removal, or require contacting support for it.
- Do not keep two paths through the credits step.
- Do not make the dashboard re-ask a question answered in onboarding.
- Do not warn about the balance before anything has been sent.
- Do not put three ways to pay on one screen.
- Do not use 30 days for a month or 7 days for a week anywhere in pricing.
- Do not let the client compute a price, an email count or a duration. All from the API.
