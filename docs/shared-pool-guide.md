# The shared sending pool: a plain guide

This guide explains every part of **Admin → Sending pool**: what each number means, where it comes from, and what to do about it. Every example uses the same small made-up pool, described in section 1, so the numbers connect from one section to the next.

---

## 1. What the shared pool is

Aperture owns its own email domains and mailboxes. **Every customer sends from them, mixed together.** Customers never bring their own domains. This page is where you look after that pool.

### The life of a domain

| Stage | How long | What it sends |
|---|---|---|
| **Aging** | 30 days | Nothing. A brand-new domain that sends straight away looks like spam. |
| **Warming up** | 29 days | Each mailbox ramps up: **5** a day (days 1–7), **10** (days 8–14), **20** (days 15–21), **30** (day 22 on). |
| **Active** | as long as it stays healthy | **30** a day per mailbox. A domain has up to 3 mailboxes, so at most **90** a day per domain. |
| **Burned** | until retired | No new cold email. It only keeps answering conversations it already has. |
| **Retired** | — | Switched off. |

From buying a domain to full volume takes about **9 weeks** (30 + 29 days, plus a little margin). That delay is why the page is always thinking ahead about **spare domains**.

### When does a domain burn?

A domain burns when its **bad rate** goes over **5%** on its **last 200 emails** (a single mailbox: its last 50).

**Bad rate** = (hard bounces + complaints × 10) ÷ emails sent. A complaint counts **ten times** because a "this is spam" click hurts a domain far more than a dead address.

> **Example.** Out of a domain's last 200 emails, 6 bounced and 1 person marked it as spam.
> Bad = 6 + (1 × 10) = 16. Bad rate = 16 ÷ 200 = **8%**, which is over 5%, so **the domain burns**.
> With the same 6 bounces and no complaint: 6 ÷ 200 = **3%**, so it keeps sending.

### Our example pool (used in every example below)

- **10 active domains**, 3 mailboxes each.
- **2 warming domains** on warmup day 10, 3 mailboxes each.
- **4 spare domains** in total (aging + warming).
- **Customer A** has a daily budget of **$20**, and **Customer B** has **$8**.
- Each email costs the customer **$0.04**.

---

## 2. The top of the page

| Control | What it does |
|---|---|
| **Charts / Numbers** | Two ways to show the same figures: as charts, or as plain tables. The action tables at the bottom (section 6) show in both. |
| **Recalculate** | Figures recalculate by themselves every 15 minutes. Press this to recalculate right now, for example just after adding domains. |
| **"Figures from 3m ago"** | How old the figures on screen are. |

---

## 3. Alert cards (only when needed)

### "Restock: add N domains"

The daily check decided you need more domains. The card says:
- why;
- how long your spare domains last at the current burn rate, or that nothing has burned yet;
- some neutral domain names you could buy.

**What to do:** buy the domains yourself, 3–5 at a time, from more than one registrar, then add them on the **Domains** page.

- **I'll add them:** marks the request as accepted. It closes by itself once the domains are added.
- **Dismiss:** closes it without doing anything.
- **Note:** optional. It's saved in the log.

> Nothing is ever bought automatically.

### "example.com is paused"

That domain failed its own authentication check: SPF, DKIM or DMARC. This is a setup problem on **our** side, not a customer's bad list. Nobody new is sent from it, but existing conversations carry on.

**What to do:** fix the DNS records, write what you fixed (at least 5 characters, logged), and press **Resume sending**.

---

## 4. Charts view (the default)

### 4.1 The headline card

The big headline names **the single most important problem**, picked in this order:

1. Nothing can send
2. Out of capacity
3. Buy domains today
4. Domains in the at-risk band
5. Bad-email rate is high
6. Capacity is tight

If none of these apply, it says **"The pool is healthy"**. If there are more problems, it adds "N other things to watch below".

The four cards under it:

| Card | Meaning | Example |
|---|---|---|
| **Daily capacity** | How many emails the whole pool can send today: every mailbox's limit for today added up, at most 90 per domain. | 10 active domains × 90 = 900, plus 2 warming domains × (3 mailboxes × 10) = 60. **960 a day.** |
| **Free for new customers** (or **Short by**) | Capacity minus what customers asked for. "Room for N more $20-a-day customers" = free ÷ 500. If customers asked for more than the pool can send, it turns red and shows how much you're short. | A asks $20 ÷ $0.04 = 500 emails, B asks $8 ÷ $0.04 = 200, so 700 together. Free = 960 − 700 = **260**. Room for 260 ÷ 500 = **0 more** $20 customers. |
| **Burned mailboxes** | How many mailboxes are burned, what share that is, and about how much daily capacity was lost. Each mailbox counts at the limit it had when it burned. | A mailbox that burned on warmup day 3 was sending 5 a day, so it counts as **5 lost**, not 30. |
| **Live conversations on burned** | People who replied in the last 30 days and are tied to a burned mailbox, plus follow-ups still going and how many customers that affects. Those conversations cannot move to another mailbox. | 7 live conversations, 12 follow-ups, 4 customers. |

### 4.2 Capacity

**Today panel**
- **Can send:** today's capacity (960 in our example).
- **Customers asked for:** the daily budgets of launched customers with Autopilot on, turned into emails (700).
- **Sent so far today.**
- **Free** (or **Short**).
- **The bar:** customers in gold, free capacity in green, with a marker at what's been sent today.
- **Internal outreach:** your own outreach only uses capacity no customer needs, and gives it back as soon as a customer does. It never reduces "Free".
- **One domain sends at most 90 a day:** so capacity only grows when new domains go live.

**Last 30 days chart**
- **Gold area:** what was sent each day.
- **Dashed line:** what the pool could send.
- **Dotted line:** what customers asked for.

The gap between the two lines is room for new customers.

### 4.3 Burned

**What the pool is made of:** every mailbox by state: Sending, Warming up, Setting up (bought but not connected yet), Burned (replies only), Retired.

**What burned mailboxes still carry**
- **Capacity lost, a day.**
- **We still pay a month:** burned mailboxes × their monthly price, plus burned domains × yearly price ÷ 12.

  > 3 burned mailboxes × $3 + 1 domain × $15 ÷ 12 = $9 + $1.25 = **$10.25 a month**.
- **Live conversations, follow-ups still going, customers affected, burned domains.**

**Why they burned (last 30 days)**
- **Too many bad emails:** over 5%.
- **DKIM record lost:** its signing record disappeared from DNS.
- **Failed the seed test:** our own test inbox couldn't confirm its signature.
- **Other.**

Below it, **Domains by stage** counts how many domains are aging, warming, active, burned and retired.

**Domains burned per week**
- **Burn rate, 30 days:** domains burned ÷ every domain that was sending in that period (still active + burned).

  > 2 burned and 10 still active: 2 ÷ 12 = **16.7%**.
- **Burned this week** and **Burned in 30 days.**
- **Average a week:** a running average where recent weeks count more.
- **The bars:** burned per week, with the average as a line and a dashed "next week" forecast. The forecast is simply the current average.
- **"Expected in the next 30 days":** domains in the at-risk band now, plus the weekly average for the rest.

  > 1 domain at risk, average 0.5 a week, 9 others out of 10: 1 + 0.5 × 4.3 weeks × 9/10 ≈ **3 domains**.

### 4.4 Health

**Bad emails, whole pool:** today, last 7 days and last 30 days, weighted like the burn rule (complaint = 10 bounces). The chart has two lines:
- **3% warmup holds:** warming mailboxes stop moving up the ramp until they're cleaner.
- **5% a domain burns:** the rate at which a single domain burns.

> ⚠️ Each domain is judged on **its own** last 200 emails. The pool average can be 1% while one domain is at 8% and burns.

**Risk by domain:** a score from **0 (safe) to 1**. It ranks what to look at first. It is **not** a forecast and does not say "burns in a week".

How it's built:
- **50%:** this week's bad rate (full marks at 5%);
- **30%:** how fast it's rising compared with the last 30 days (full marks at +2 points);
- **20%:** complaints (full marks at 0.3%).

> **Example.** This week 2.5% bad, up 1 point on the month, 0.15% complaints.
> 0.5 × (2.5 ÷ 5) + 0.3 × (1 ÷ 2) + 0.2 × (0.15 ÷ 0.3) = 0.25 + 0.15 + 0.10 = **0.50**, which is in the **watch** band.

- **Watch:** 0.4 to 0.7.
- **At risk:** 0.7 or more.
- Domains with fewer than 200 emails in 30 days are not scored yet.

### 4.5 Spare domains and restock

**Spare domains** = domains already bought that aren't sending at full volume yet (aging + warming up).

The **Restock panel** has two halves.

**Left half: your spares**
- The count against your minimum, with a bar.
- How many are aging, how many are warming, and how many go live this week.
- **Stuck:** a domain whose slowest mailbox is 3 or more days behind its warmup schedule, or that hasn't been checked for 3 days.

  > It started warming 12 days ago, so it should be on day 12, but it's on day 8. That's 4 days behind, so it's **stuck**. Look at it.

**Right half: "Today"** shows **Buy N domains** or **Nothing to buy**, plus when domains bought today would start warming and reach full volume. It checks three reasons and buys for the **biggest** one, never more than "Most domains per restock":

| Reason | Rule | Example |
|---|---|---|
| **Below the minimum** | You have fewer spares than your target. | Minimum 15, you have 4: need **11**. |
| **To replace burn** | At the current burn, the spares run out before a new domain could be ready (~9 weeks). Doesn't apply if nothing has burned. | 4 spares at 0.5 burned a week last 8 weeks. That's less than 9, so buy (9 − 8) × 0.5, rounded up: **1**. |
| **For demand** | Customers want more than the pool can send, times your demand margin. | Margin 1.2: 700 × 1.2 = 840 needed. With 960 capacity that's fine. With only 600, you're 240 short; 240 ÷ 30 = 8 mailboxes = 3 domains, so **3**. |

> The biggest need is 11, but "Most domains per restock" is 5, so the answer is **Buy 5**. The rest comes in the next request.

**Next 12 weeks chart**
- **Green:** spares going live.
- **Red:** domains expected to burn.

If the red line goes above the green, the pool starts shrinking from that week. A gold marker shows when a domain bought today would go live.

**Stages:** the ladder from aging to active, with how many domains sit on each step.

**Every spare domain:** one timeline bar per domain, from bought to live, with its warmup day and days remaining. Stuck ones are flagged.

### 4.6 Cost per email (internal only, never shown to customers)

The headline gives what one email costs you, against the **$0.04** you charge, and the gross margin.

**Where each $0.04 goes** (last 30 days, per email and per month):

| Cost | How it's worked out |
|---|---|
| **Infrastructure** | Mailboxes × monthly price + burned mailboxes × their price + domains × yearly price ÷ 12. |
| **AI** | Priced from the tokens each AI call actually used. |
| **Data** | Apollo: people revealed and searches. |
| **Verification** | MillionVerifier address checks. |
| **Card fees** | Stripe fees on customer top-ups. |

> **Example.** 36 sending mailboxes × $4 = $144, plus 3 burned × $3 = $9, plus 13 domains × $15 ÷ 12 = $16.25. Infrastructure = **$169.25 a month**.
> If the pool sent 12,500 emails: $169.25 ÷ 12,500 = **$0.0135 per email** for infrastructure.

Cost per email = all costs ÷ all emails sent. That includes your own internal outreach, which pays nothing.

**AI by job:** calls, average tokens and cost per call for each job: writing a person's 4 emails, fact-checking an email, reading a reply and drafting an answer, website analysis, sample emails.

> If it says "N counted AI calls have no token record": those calls aren't in the AI cost. They were made before tokens were recorded, or they failed before the AI reported its tokens.

**Unit prices (editable):** every figure above is calculated from these, so update them whenever an invoice changes:
- Apollo per person and per search;
- MillionVerifier per address;
- card fee (%) and card fee per payment;
- **Mailbox per month**, **Burned mailbox per month until retired**, **Domain per year**;
- **AI models:** price per million input, cached input and output tokens. "Any other model" is used for models not listed. **Add a model** adds a new row.

**Per domain:** each domain's emails a day (last 7 days), infrastructure per month, per email, all-in per email, and margin per email.

> A warming domain with 3 mailboxes costs 3 × $4 + $15 ÷ 12 = $13.25 a month. Sending 5 a day: $13.25 ÷ 30 days ÷ 5 = **$0.088 per email**, more than the $0.04 charged. That **loss is normal** while a domain warms up; it disappears at full volume.

### 4.7 Mixing and safety

**Mixing:** on average, how many different customers send from one domain per day.

| Customers per domain | Level |
|---|---|
| under 2 | no protection: one customer's bad list hits a domain directly |
| 2 to 10 | weak |
| 10 to 30 | working |
| 30 or more | fully mixed |

> With 12 customers on a domain, one customer's bad list is only a small share of that domain's mail, so it can't drag the domain down alone.

**Authentication:** how many live domains pass all three DNS records (SPF, DKIM, DMARC). A domain missing one lands in spam far more often.

**Unmatched replies:** incoming emails that couldn't be tied to an email we sent. A rising line means reply matching is broken. Open the queue on the **Unmatched** page and assign them by hand.

**Registrars / DNS providers / Sending servers:** how your domains are spread across providers.

> If one registrar holds 80% of your domains and it has a problem, 80% of the pool is hit at once. Spread new domains across providers.

---

## 5. Numbers view

The same figures as plain tables:
- **Four counts:** active domains and mailboxes, warming, burned mailboxes, domains retired in 30 days.
- **Burned domains:** burn rate, average a week, burned in 7 and 30 days, expected in the next 30 days, and mixing.
- **Spare domains:** count against the minimum, how long they last ("no burn yet" when nothing burns), the three restock reasons, and domains per warmup step.
- **Capacity:** can send today, customers asked for, room for more $20-a-day customers, internal outreach, and most one domain sends.
- **Cost and margin:** cost per email, margin per email, all costs, charged to customers, gross margin (30 days).
- **Domains at risk:** sends, bounces and complaints (7 days), change against 30 days, risk score and band.
- **Authentication:** which domains miss which record.
- **Unmatched replies** and **Where the domains are.**

---

## 6. Always at the bottom (both views): what you act on

### Spare domains, one by one

Each aging or warming domain, with:
- its progress and the date it goes active;
- how much it can send today;
- its bad rate over 7 days;
- a "stuck" flag where relevant.

**Activate now** skips the rest of warmup and sends the domain to full volume. This is risky, because its reputation isn't built yet. You must write why (at least 10 characters, logged with your name). It is **refused** if:
- any DNS record (SPF, DKIM, DMARC) is missing;
- our DKIM signature hasn't passed the seed test in the last 3 days;
- its 7-day bad rate is 2% or more.

> Use it only for a real reason, such as "big customer starts Monday and we're 200 emails a day short". Every early promotion is listed under **Promoted early**.

### Burned in the last 30 days

Domain, date (burned or retired), why, the **bad rate** over the emails that decided it, and how many days it lasted. Domains that were promoted early are flagged.

### Promoted early (only shown if any)

Who promoted which domain, from which warmup day, why, and its bad rate since. If it burns later, you can trace it back to that decision.

### Restock

**Targets**

| Setting | Meaning | Example |
|---|---|---|
| **Spare domains, minimum** | How many not-yet-sending domains to always have ready. | 15 |
| **Demand margin** | Keep capacity at this multiple of what customers asked for. | 1.2 means 20% extra |
| **Most domains per restock** | A restock request never asks for more than this. | 5 |

**Request history:** when each request was raised, its status, how many domains it asked for, how long the spares lasted at the time, and your note.

| Status | Meaning |
|---|---|
| **Pending** | Waiting for you. |
| **Approved** | You said you'd add them. |
| **Done** | The domains are in. |
| **Dismissed** | Closed without action. |

---

## 7. Quick glossary

| Word | Meaning |
|---|---|
| **Capacity** | Emails the pool can send today. |
| **Asked for** | Emails launched customers' daily budgets pay for ($ ÷ $0.04). |
| **Bad rate** | (Hard bounces + complaints × 10) ÷ emails. |
| **Burned** | Over 5% bad on its last 200 emails (mailbox: 50). Stops cold email and keeps answering existing conversations. |
| **Spare domains** | Bought but not sending at full volume yet (aging + warming). |
| **Runway** | How many weeks the spare domains last at the current burn. There is none when nothing burns. |
| **Stuck** | A warming domain 3+ days behind schedule. |
| **Risk score** | 0–1 ranking of which domains to check first. Not a forecast. |
| **Mixing** | Customers per domain per day. More is safer. |
| **Restock request** | A reminder to buy N domains. You buy them; nothing is automatic. |
