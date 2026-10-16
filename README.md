# Aperture

Multi-tenant outbound email SaaS. A company enters its domain, gets a free analysis and preview, sets a daily
budget, tops up prepaid credits ($0.04 per email, paid in the page with Stripe Elements) and launches its first
campaign the same day from a shared, warmed sending pool.

- `apps/server`: Node, Express 5, TypeScript, Prisma, PostgreSQL, optional Redis
- `apps/client`: Next.js (App Router), TypeScript, Redux Toolkit / RTK Query, Tailwind
- `infra`: Docker Compose for local services, Dockerfiles, Cloud Build and GCP scripts
- `docs`: architecture, API map, schema, auth, Stripe, SaaS model, deployment, feature map, migration plan, business analysis

## Local setup

Requirements: Node 20 or newer, Docker (or your own PostgreSQL 16 and Redis 7).

```bash
npm run setup
npm run dev
```

`npm run setup` starts Postgres and Redis in Docker, installs packages, creates `apps/server/.env` with fresh
local secrets and `apps/client/.env.local`, applies migrations (never resets data) and seeds the plans. On
the first run it also creates a platform admin and prints its password once. `npm run dev` runs the API
and the web app together. It also starts the Docker database and Redis first, so Docker Desktop must be
open. If you run your own PostgreSQL instead, set `APERTURE_NO_DOCKER=1`.

The web app runs on http://localhost:3100 and proxies `/api` to the API on port 4000. The Docker
Postgres listens on port 55432 and the web app on 3100 so they don't clash with other local projects
that commonly use 5432, 5433 or 3000.

Integrations switch on when their keys are set in `apps/server/.env`: Mailgun SMTP (email verification with
number match and password reset), Stripe (billing), OpenAI (site
analysis and sequences), Apollo (market sizing and leads), Smartlead (campaigns and mailboxes), Google
OAuth (sign in). Without a key, the related screens say what is missing instead of showing sample data.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs the API tests (they need the `aperture_test` database that `npm run db:up` creates)
and then the web tests, which run in jsdom with the network mocked.

## Deploying

See `docs/deployment.md` for Cloud Run, Cloud SQL, Memorystore, Secret Manager and Cloud Scheduler, and
`docs/migration-plan.md` for the cut-over checklist and known gaps.
