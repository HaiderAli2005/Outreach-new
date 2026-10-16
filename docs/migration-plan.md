# Migration plan

## Phases

| Phase | Work | Status |
|---|---|---|
| 1 | Inspect the design file and the source app | done |
| 2 | Docs in this folder | done |
| 3 | Monorepo, tooling, Prisma schema, env config | done |
| 4 | Database, auth, core API, design system, app shell | done |
| 5 | Port engine features (inbox, leads, batches, campaigns, blocklist, settings, jobs, webhooks, reply intelligence) | done, see gaps below |
| 6 | Build every feature in the Aperture UI | done |
| 7 | Stripe | done |
| 8 | SaaS: organizations, roles, entitlements, platform admin | done |
| 9 | Performance pass (denormalised thread fields, indexes, RTK Query caching, streaming CSV) | done |
| 10 | Tests and fixes (API integration tests, web unit and component tests) | done |
| 11 | Cloud Run / Cloud SQL / Memorystore / Secret Manager deployment config | written; see `deployment.md` (images not built in the authoring sandbox because Docker Hub rate-limited the base image pull) |

## Dependency review

| Source dependency | Decision | Reason |
|---|---|---|
| `express` 4 | **upgraded** to 5 | native async error handling |
| `express-async-errors` | removed | Express 5 does it |
| `body-parser` | removed | built into Express |
| `mysql2` | removed | PostgreSQL + Prisma |
| `bson-objectid` | removed | Prisma `cuid()` ids |
| `bcrypt` | **kept** | now actually used for password hashing |
| `jsonwebtoken` | **kept** | access tokens |
| `cookie-parser` | **kept** | refresh cookie |
| `cors` | **kept** | allow-list for the web origin |
| `dotenv` | **kept** (dev only) | local `.env`; production reads Secret Manager-backed env vars |
| `ioredis` | **kept**, optional | job locks and rate-limit store |
| `bottleneck` | **kept** | per-provider API rate limits (Smartlead, Apollo, MillionVerifier) |
| `openai` | **kept** | classification, drafts, analysis, personalization |
| `axios` | removed | Node 20 `fetch` is enough |
| `node-cron` | removed | Cloud Scheduler triggers `/jobs/:name/run` |
| `@slack/web-api` | removed | only used for CSV file uploads; alerts use the incoming webhook over `fetch` |
| `concurrently`, `cross-env`, `nodemon` | replaced | npm workspaces scripts + `tsx watch` |
| — | added `zod` | request and env validation |
| — | added `helmet`, `express-rate-limit` | security headers, rate limiting |
| — | added `pino`, `pino-http` | structured logs for Cloud Logging |
| — | added `stripe` | billing |
| — | added `@prisma/client`, `prisma` | ORM and migrations |

Frontend: `bootstrap`, `sass`, `redux-persist` and the custom API middleware are replaced by Tailwind and
RTK Query. `@stripe/stripe-js` and `@stripe/react-stripe-js` are added for PCI-safe card entry.

## Data migration from the MySQL database

`apps/server/scripts/import-legacy.ts` is not included: the source database belongs to one customer and holds
live personal data, so moving it is an operator decision. The mapping is documented in
`database-schema.md`; an import would create one `Organization`, map `settings` → `OrgSettings` +
`IntegrationCredential`, and copy campaigns, companies, contacts, messages, blocklist and batches with the
enum values upper-cased.

## Deliberate behaviour changes

1. **Campaign CRUD** is allowed for draft/paused campaigns (the source forbade it because one customer's
   autopilot owned them). Running campaigns still only pause/resume.
2. **Brand-neutral prompts.** Classification, drafting and personalization prompts in the source were
   written for one Swedish AI-SEO agency (Swedish grammar rules, competitor lists, a fixed signature).
   The rebuild keeps the structure and the safety rules and fills brand, value proposition, language,
   signature and opt-out line from each organization's settings.
3. **Market-specific heuristics not ported:** Swedish competitor/junk regexes in `scoring.js`, region
   graduation and the niche ladder in `sourcingJob`, AI campaign generation for Swedish niches,
   `replyGuard` language validators, attachment vision. Scoring keeps the generic parts (seniority,
   decision-maker titles, email status, company size, junior-title penalty). Replies with attachments are
   escalated to a human instead of being described by a vision model.
4. **Passwords** are hashed; existing plaintext passwords cannot be migrated and users reset them.

## Known gaps (not faked)

| Gap | Why | What the app does |
|---|---|---|
| Domain registration | No registrar integration exists in either source | Selected domains are paid for and stored as `PENDING_REGISTRATION`; the UI shows that status. Integrating a registrar API means implementing `integrations/registrar.ts`. |
| Creating Google/Microsoft inboxes | Not in either source | Planned inboxes are stored as `PLANNED`/`PENDING`. Real sending uses mailboxes already connected in Smartlead (listed and attached from Settings → Sending), exactly as the source did. |
| Smartlead statistics reconciliation in reply-sync | 40 KB of recovery logic for missed webhooks on one account | Webhooks are the source of truth; the classify and follow-up sweeps run. |
| Apollo account import and signals | Fed Swedish-market scoring only | Not exposed. |
| Attachment vision and reply-guard validators | Swedish-specific | Replies with attachments go to a human. |
| AI features without an OpenAI key | Key is a deployment secret | Analysis, previews, drafts and personalization report that AI isn't configured; nothing is invented. |
| Slack CSV report upload | Dropped `@slack/web-api` | Reports post a text summary to the Slack webhook. |
| Team invites by email | Account email now exists (Mailgun SMTP, used for verification and password reset) but invites don't use it yet | The invite dialog returns a link the admin sends themselves. |

## Added after the rebuild: email verification and password reset

Ported from RankHouse's number match (see `authentication.md`). Checklist to switch it on:

- [ ] Mailgun sending domain verified (SPF, DKIM, DMARC records added at the DNS provider)
- [ ] `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM` set on the API
- [ ] `WEB_ORIGIN` set to the public web address, because the email links are built from it
- [ ] Mailgun click tracking off for the sending domain, so the number links aren't rewritten
- [ ] Migration `20260924120000_email_challenge` applied (`prisma migrate deploy`)
