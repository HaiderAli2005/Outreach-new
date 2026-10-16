# Aperture spec 4: pricing and the credits experience

This replaces the pricing decisions in spec 3 §C.3 and the credits-panel design in spec 1 §9.
Everything else in specs 1, 2 and 3 stands.

It is based on **observed billing data from inside a live, paying Explee account on 9 Oct 2026**,
not on inference.

---

## 0. What Explee actually does, with evidence

Read from their own Billing page and dashboard:

```
Usage
Last 30 days · 561 emails · $28.05 · $0.05 per email sent (Classic)

Oct 9   200 emails × $0.05   $10.00
Oct 8   201 emails × $0.05   $10.05
Oct 7   160 emails × $0.05   $8.00
```

```
Daily budget                              $10
[────────────────────────────────]
Balance $1.90                      ⚙  Top up
```

```
BALANCE
$1.90                                  [Top up]
Postpaid · Tier 1 · up to $5 of usage
No prepayment needed. We charge your card for actual usage once it
reaches $5, or about a week after you stop sending if you use less.
Remove your card via Stripe Customer Portal to stop charges.
```

Dashboard performance tiles: `SENT 561 · 561 first emails, 0 follow-ups` and
`SPENT $28.05 · 561 emails × $0.05`.

Five facts follow, and all five matter:

1. **The price is now $0.05 per email.** It has gone $0.03 → $0.04 → $0.05 in under a year.
2. **It is flat.** Every line is `N emails × $0.05`. They count first emails and follow-ups
   separately in the dashboard but **bill them identically**. There is no follow-up discount
   anywhere in their product.
3. **The daily budget is the only volume control.** They never ask "how many emails a day". They
   ask how many dollars a day, and the emails are derived. Oct 9 shows the cap working exactly:
   `$10.00 / $10.00 daily budget` and precisely 200 emails.
4. **They are postpaid in tiers**, charging the card once usage reaches $5. This is what produces
   their worst reviews, and we are not copying it.
5. Card and invoices are handled by the **Stripe Customer Portal**, not by screens they built.

---

## 1. The decision: $0.04 per email, flat

**One price. Every email. First touch, follow-up two, follow-up three, follow-up four, all $0.04.
Replies to a human who replied to you are free.**

```ts
// apps/server/src/domain/credits/costs.ts
export const COSTS: Record<string, DeciCents> = {
  "email.sent":  40n,   // every outbound cold email, first touch or follow-up
  "email.reply":  0n,   // answering someone who answered you
  "lead.found":   0n,   // included
  "lead.verified": 0n,  // included
  "ai.research":  0n,   // included
  "ai.write":     0n,   // included
};
```

### Why 4 cents

**It is 20% under the market leader.** Explee is at $0.05. "20% cheaper than Explee" is a sentence
a salesperson can say.

**It makes every number in the product round.** This is not cosmetic; it is the reason the UX
works at all:

```
$10 a day  →    250 emails a day
$20 a day  →    500 emails a day
$40 a day  →  1,000 emails a day
$100 a day →  2,500 emails a day
$200 a day →  5,000 emails a day
```

Those are exactly the volume presets already in the onboarding. At $0.045 they become $11.25,
$22.50, $45. At $0.05 there is no price advantage. $0.04 is the only value that gives both.

**The margin is better than the split it replaces:**

```
a 4-touch sequence
  revenue  4 × $0.04                    = $0.160

  cost
    lead data, once                       $0.010
    verification, once                    $0.001
    AI writing, 4 × $0.008                $0.032
    mailbox + domain + burn, 4 × $0.006   $0.024
                                          ------
                                          $0.067

  margin  $0.093                          58%
```

Against Explee's $0.20 for the same person, we charge $0.16.

---

## 2. Remove the follow-up split

The $0.045 / $0.025 split was never a researched finding. It was a proposal, and the evidence
above shows the market leader does not do it. It also caused a concrete defect, which is the main
reason to remove it.

### The defect

The onboarding card currently reads:

```
$50   1,666 emails   Lasts about 3 days
```

1,666 comes from `$50 ÷ $0.03`, and $0.03 is a blend that assumes **every prospect receives
exactly four emails**: `(45 + 25 + 25 + 25) ÷ 4 = 30`.

That never happens. Prospects reply, bounce or unsubscribe at touch one, which stops the sequence
and leaves the real mix weighted toward the expensive first touches. So the true blend is above
$0.03 and **the customer always gets fewer emails than the card promised**. The number cannot be
made true while the split exists.

### The second cost: the copy

```
BEFORE (45 words)
Prepaid, so you never get a surprise bill. The first email to someone is $0.045
and each follow-up $0.025; finding people, verifying them and writing every email
are included, and if we don't find an address you pay nothing. Replies to people
who answer are always free.

AFTER (24 words)
$0.04 an email, prepaid, so you never get a surprise bill. Finding people,
verifying them and writing every email are included. Replies are free.
```

### What this does to the sabotage problem

The split existed to stop customers switching follow-ups off to save money. Section 3 solves that
better: when the customer sets a **daily budget** rather than a per-email allowance, cutting
follow-ups does not save them anything. The budget is spent either way, just on different people.
The incentive disappears without any pricing cleverness.

---

## 3. Step 5 becomes a daily budget, not an email count

This is the fix for the UX problem. Today the product asks two questions in two different units,
and leaves the customer to reconcile them:

```
step 5   "How many emails a day?"   → 500
step 6   "Add credits"              → $25 (lasts about a day)
```

The customer has just committed to a month of sending and is then offered one day of fuel, priced
in a unit they were never shown. Nothing on screen connects 500 to $25.

**Ask one question, in money.**

```
┌──────────────────────────────────────────────────────┐
│  How much a day?                                     │
│                                                      │
│      $20  a day                                      │
│      [──────●───────────────────────────────]        │
│      $4                $40               $200        │
│                                                      │
│   [ $10 ]  [ $20 ]  [ $40 ]  [ $100 ]  [ $200 ]      │
│                                                      │
│   500 emails a day · 125 new people a day            │
│   about $440 a month at this rate                    │
└──────────────────────────────────────────────────────┘
```

The slider moves dollars. Emails and people are shown underneath as derived figures, not as inputs.

Keep the existing explanatory line below it, which is good and should stay:

> At $20 a day you reach about 2,750 new people a month, each with a 4-email sequence over two
> weeks, so your market lasts 24+ months.

Store it as a single field, which spec 3 §E.4 already specified:

```
projects.daily_budget_decicents   bigint
  0     = paused
  null  = no cap (not offered in onboarding; admin only)
```

Delete `emails_per_day` as an input. Where the number is still needed internally, derive it:

```
emails_per_day = daily_budget_decicents / 40n
```

**One number the customer controls, forever.** It is the same number on the onboarding step, on
the dashboard, and in settings. Nothing to reconcile.

---

## 4. Step 6: top-ups derived from the budget

Stop showing a fixed `$25 / $50 / $100 / $250 / $500` list. Those amounts mean nothing until you
know the daily rate, which is why "$25 · lasts about a day" reads as nonsense right after choosing
500 a day.

**Offer time, priced at the rate they just chose.**

At $20 a day:

```
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  3 days     │ │  1 week     │ │  2 weeks    │ │  1 month    │
│             │ │ RECOMMENDED │ │             │ │             │
│   $60       │ │   $140      │ │   $280      │ │   $600      │
│ 1,500 emails│ │ 3,500 emails│ │ 7,000 emails│ │15,000 emails│
│ 375 people  │ │ 875 people  │ │1,750 people │ │3,750 people │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘

              Or enter another amount  [        ]
```

Rules:

- Amounts are `daily_budget × {3, 7, 14, 30}`, rounded up to the nearest $5.
- **"1 week" is the default selection**, not the smallest option.
- Minimum $25 still applies; if `daily_budget × 3` is below it, the first card becomes $25 and is
  labelled with however many days that actually buys.
- The free $10 trial card stays where it is.
- Every card states days, dollars, emails and people. All four are now exactly true, because the
  price is flat.

### The copy

```
Prepaid, so you never get a surprise bill. $0.04 an email, including finding the
person, verifying the address and writing every message. If we can't find an
address you pay nothing, and replies are free.
```

---

## 5. Auto-reload, so prepaid does not mean running dry

Explee avoids the empty-balance problem by being postpaid, which is also why their reviews say
things like "they keep charging even when you stop campaigns" and "no way of cancelling credit
card once added."

Do not copy that. Get the same convenience with none of the distrust:

```
☑  Keep me topped up automatically
   When my balance drops below  [$40 ▾]  charge my card  [$140 ▾]

   Off by default. Turn it off any time. We never charge more than
   this, and never when it is switched off.
```

- **Off by default.** A customer who never opts in can never be charged unexpectedly.
- Defaults when they do opt in: threshold = 2 days of budget, amount = the top-up they last chose.
- One charge per 24 hours, maximum, whatever happens.
- A failed auto-reload disables auto-reload, emails the customer, and lets the balance run to zero
  normally. It is never retried silently.
- Every auto-reload is emailed with a receipt.

This is how AWS, Twilio and OpenAI handle prepaid balances. It is a well-understood pattern and it
is the honest version of what Explee gets from postpaid.

---

## 6. The dashboard control

Explee puts the budget slider and the balance together on the dashboard, always visible, and it is
the single best piece of their UI. Copy the shape:

```
┌────────────────────────────────────────────────────────────┐
│  Daily budget                        ⓘ              $20    │
│  [────────────●─────────────────────────────]              │
│                                                            │
│  Today     $14.80 / $20.00                                 │
│  [████████████████████░░░░░░░░]                            │
│  370 sent today · 92 people reached                        │
│                                                            │
│  Balance $186.40 · about 9 days        [ Top up ]          │
└────────────────────────────────────────────────────────────┘
```

Moving the slider takes effect immediately, with no save button and no confirmation. Setting it to
$0 pauses sending; the balance is untouched and live conversations keep running.

### The nudge, done honestly

Explee shows this when a campaign hits its budget:

> Add $3 to $10 a day for ~1 to 10 more leads a month
> Your campaigns hit today's budget, a higher budget sends more of them
> `200 sent today for $10.00` ········ `60 more emails for +$3`

Worth copying, with one correction. "~1 to 10 more leads a month" is a ten-fold range presented as
a prediction. Use the customer's own measured reply rate instead, and say it is an estimate:

> **You hit today's budget at 2:40pm.** 500 sent, and 180 people were ready to go.
> At your reply rate of 2.1%, another $8 a day would be about 4 more replies a month.
> [ Not now ]  [ Raise to $28 a day ]

Only show it when the budget was actually exhausted **and** there were queued prospects. Never as a
standing upsell.

---

## 7. Code changes

```
costs.ts
  REMOVE  email.first_touch: 45n
  REMOVE  email.follow_up:   25n
  ADD     email.sent:        40n
  KEEP    email.reply:        0n

money.ts
  REMOVE  PRICE_FIRST_TOUCH, PRICE_FOLLOW_UP, priceForStep()
  ADD     PRICE_PER_EMAIL: DeciCents = 40n
  KEEP    PRICE_REPLY = 0n

delivery.ts
  charge PRICE_PER_EMAIL for every step >= 1, regardless of step number
  step 0 (a reply to a human) stays free

onboarding step 5
  REPLACE the emails-per-day slider with a dollars-per-day slider
  presets $10 / $20 / $40 / $100 / $200
  show emails/day and people/day as DERIVED text, not inputs
  write projects.daily_budget_decicents

onboarding step 6
  REPLACE the fixed $25-$500 list with duration cards
  amounts = daily_budget × {3, 7, 14, 30}, rounded up to $5, floor $25
  default selection = 1 week
  each card shows days, dollars, emails and people

credits panel
  add the auto-reload block (§5), off by default
  "about N days left" uses daily_budget, not a blended guess

dashboard
  add the budget card (§6): slider, today's spend against budget, balance, Top up
  add the budget-exhausted nudge, using the customer's measured reply rate

delete
  emails_per_day as a stored input anywhere; derive it
  every blended-rate constant used to estimate "how many emails will $X buy"
```

---

## 8. Acceptance criteria

- Every outbound cold email costs exactly 40 deci-cents, whatever its step number.
- A reply to a human costs 0.
- `$20 a day` displays exactly `500 emails a day`. No rounding, no "about".
- A top-up card that says `3,500 emails` delivers exactly 3,500 emails. There is a test that runs
  a mixed workload (some prospects replying at touch 1, some bouncing, some completing all four)
  and asserts the count is exact.
- Setting the daily budget to $0 stops new sends within one cycle and does not touch the balance
  or any live conversation.
- With auto-reload off, no charge can occur without the customer pressing a button.
- With auto-reload on, at most one charge occurs in any 24 hours, and a failed charge disables it
  and sends an email.
- The budget nudge appears only when the budget was exhausted and prospects were queued.
- `grep -r "first_touch\|follow_up\|priceForStep\|0\.045\|0\.025\|0\.03" apps/` returns nothing in
  pricing code.

---

## 9. Do not do

- Do not charge a different price for a follow-up than for a first email. The market leader does
  not, and it makes every estimate in the product untrue.
- Do not ask the customer for a volume in emails. Ask in money; derive the emails.
- Do not offer a fixed top-up list that ignores the daily budget.
- Do not go postpaid, do not accrue a balance, and do not retry a failed card off-session. Their
  billing is their worst-reviewed feature and prepaid is our answer to it.
- Do not turn auto-reload on by default, and do not hide the switch.
- Do not show a predicted lead range of "1 to 10". Use the customer's measured rate, and label it
  an estimate.
- Do not show a number of emails that depends on an assumed sequence length. With a flat price no
  such number exists, which is the point.
- Do not remove the customer's ability to delete their card and close their account themselves.
