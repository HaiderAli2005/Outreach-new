# Business analysis (prompt v1)

The Analysis step of onboarding follows `analysis-prompt-v1.md`: one AI call that returns
`brand_detail`, `warning` and 3 to 6 ranked `target_audience` entries, each with its own keywords.

## Flow

1. `POST /onboarding/analysis` reads the homepage and up to 9 common pages (`/about`, `/services`,
   `/products`, `/solutions`, `/pricing`, `/industries`, `/customers`, `/case-studies`,
   `/testimonials`, `/contact`). Only public IP addresses are fetched.
2. Code extracts the signals the prompt treats as facts (`modules/onboarding/signals.ts`):
   * `country` from the domain ending, otherwise the most common phone prefix on the pages
   * `language` from the homepage `<html lang>`
   * `currency` from prices on the pages (£, €, $, ₹, Rs/PKR, AED)
   * `named_customers` from image alt text under "Trusted by", "Our clients" and similar headings
   * `testimonial_titles` from "Name, Job Title" patterns
3. The system and user prompt in `modules/onboarding/analysisPrompt.ts` are the v1 text with
   `{{domain}}`, `{{today}}`, `{{pages_json}}`, `{{signals_json}}` and `{{search_results_json}}`
   filled in. `WEB RESULTS` is sent as `[]`: no web search provider is connected, so nothing is
   invented there.
4. The answer goes through the code checks below, then is stored whole in `Onboarding.analysis`
   (with `repairsMade`, the signals and the prompt version). Audiences become the buyer groups the
   user switches on and off; the facts sheet is filled from `brand_detail` with sources.

## Code checks (`modules/onboarding/analysisValidate.ts`)

| Rule from the prompt file | What the code does |
|---|---|
| 1. JSON parses | Retries the call once on invalid JSON, then fails with a clear error |
| 2. Allowed seniorities and sizes | Drops anything else |
| 3. Country names | Normalises ("UK" to "United Kingdom", "usa", "uae" and more), max 3 |
| 4. Titles | Removes descriptions ("people who..."), duplicates across audiences, trims to 8 |
| 5. Own domain | Added to every `exclude_domains`, competitors named on the site added too |
| 6. Proof and differentiators | Items without a source are removed |
| 7. Confidence below 0.4 | The three-question form is shown instead of the result |
| 8. `repairs_made` | Every change above is recorded in `Onboarding.analysis.repairsMade` |

Also enforced: at most 6 audiences (kept by priority, ids and priorities renumbered), keywords
lowercase and at most 5, lookalikes at most 5, `email_status` always `["verified"]`.

## Three questions

When the site can't be read, AI isn't set up, or confidence is below 0.4, the user answers three
questions. With AI, the answers are sent through the same v1 prompt as a page called
`user-answers`, and audience countries are limited to the countries the user picked. Without AI,
one audience is built from the answers.

## Where the audiences are used

* Market sizing: each audience is searched in Apollo with titles, similar titles, seniorities,
  company sizes, countries, keywords, technologies, hiring titles and revenue range. People at
  excluded domains are left out of the sample.
* The first campaign's lead search uses the same fields from every audience that is switched on.
* The email preview uses the description, why they buy, pains, goals and objections.

## Live progress stream

With `ANALYSIS_STREAM` on (the default), `POST /onboarding/analysis` starts the same analysis as a
background run and returns straight away with `analysisRun`. The run goes through six steps that
already existed inside the job: `fetch`, `extract`, `analyse`, `validate`, `size` (the market
count, stored in the same cache `GET /onboarding/market` reads) and `write` (the sample sequence,
stored where `POST /onboarding/preview` stores it). Every event is saved in `analysis_events`, so
`GET /analyses/:id/stream?from=<seq>` can replay a run after a reload and then continue live.
Posting again while a run is going returns that run instead of starting a second one. A run with no
new event for 3 minutes is marked interrupted.

The stored analysis is the same with or without the stream: both paths go through
`analyzeCore`, and a test compares the two. With `ANALYSIS_STREAM=false` the old single request
comes back.

Matching companies are grouped from the people sample the market count already fetches, so they
cost nothing. `companiesInSample` is the count inside the sample, never the market size. Setting
`ACCURATE_COMPANY_COUNT=true` adds one organisation count per audience, which costs one Apollo
credit each, and fills `companiesTotal`.

People in the stream show a first name and a last initial only. No email address is sent before
payment. Competitors are merged into every audience's excluded domains and are never used as
lookalike domains.
