# Architecture

Aperture is a multi-tenant cold-outreach SaaS. It is a rebuild of the `outreach-saas` engine (sourcing, AI
personalization, Smartlead sending, reply intelligence, suppression) on a new stack, presented through the
Aperture "desert gold" design system.

## Repository layout

```text
aperture-app/
├── apps/
│   ├── api/                 Express 5 + TypeScript + Prisma (PostgreSQL)
│   │   ├── prisma/          schema.prisma, migrations, seed.ts
│   │   ├── src/
│   │   │   ├── config/      env parsing (zod), plan catalogue
│   │   │   ├── lib/         prisma, logger, redis, crypto, errors, http helpers
│   │   │   ├── middleware/  auth, tenant, validation, rate limiting, errors
│   │   │   ├── integrations/ smartlead, apollo, openai, millionverifier, slack, stripe, site scrape, dns
│   │   │   ├── domain/      business rules shared by modules and jobs (suppression, dedup, scoring,
│   │   │   │                reply intelligence, auto-reply gates, personalization, batches, lead import)
│   │   │   ├── modules/     one folder per API area: routes → controller → service → repository
│   │   │   └── jobs/        scheduled work, triggered over HTTP by Cloud Scheduler
│   │   └── test/            vitest + supertest integration tests against PostgreSQL
│   └── web/                 Next.js 16 (App Router) + TypeScript + Redux Toolkit (RTK Query) + Tailwind
│       └── src/
│           ├── app/         routes: marketing, onboarding, signin, app/*, admin/*
│           ├── components/  design-system primitives, shells, feature components
│           ├── store/       Redux store, RTK Query API slices, UI slices
│           └── lib/         formatting helpers
│       └── test/            vitest + Testing Library (jsdom): sizing and format rules, auth refresh,
│                            domain search, sign up / sign in, launch progress
├── infra/                   docker-compose (local Postgres + Redis), Cloud Build, Cloud Run, Scheduler
└── docs/
```

## Request flow

```text
Browser ──HTTPS──▶ Cloud Load Balancer
                      ├── /api/*  ─▶ Cloud Run: api  (Express)
                      └── /*      ─▶ Cloud Run: web  (Next.js)

api ─▶ Route ─▶ Middleware (auth, tenant, zod validation) ─▶ Controller ─▶ Service ─▶ Repository (Prisma) ─▶ Cloud SQL
                                                                         └─▶ Integration clients (Stripe, Smartlead, Apollo, OpenAI…)
```

* Controllers only translate HTTP to service calls and back. They never touch Prisma.
* Services own business rules. Anything used by more than one module (suppression, dedup, the
  "needs reply" predicate, gates) lives in `src/domain`.
* Repositories are the only place that builds Prisma queries, and every tenant-owned query takes an
  `organizationId`.

## Frontend architecture

* Server components render the marketing page (plans are fetched from the API with ISR caching).
* Everything behind sign-in is a client tree wrapped in the Redux provider. Data fetching goes through RTK
  Query, which de-duplicates identical requests, caches per argument and invalidates by tag after
  mutations, so pages never refetch what they already hold.
* The access token lives in memory (Redux). A refresh cookie (httpOnly, `SameSite=Strict`, scoped to
  `/api/v1/auth`) silently renews it; the base query retries once after a 401.
* All UI is built from the primitives in `components/ui`, which encode the design tokens from
  `docs/design-system.md`. There is no page-specific styling system.

## Background work

The source app ran `node-cron` inside a single VM, which is why it warned "only ever run one server". On
Cloud Run instances scale to zero and scale out, so the rebuild uses Cloud Scheduler hitting
`POST /api/v1/jobs/:name/run` with a shared secret. Each job:

1. takes a distributed lock (Redis `SET NX PX`, or a Postgres advisory lock when Redis is absent),
2. iterates the organizations the job applies to (autopilot on, active subscription),
3. does bounded work per organization so one tenant can never starve the others.

## Multi-tenancy

Row-level tenancy with an `organizationId` column on every tenant-owned table, enforced in repositories and
covered by isolation tests. See `saas-architecture.md`.

## Key decisions

| Decision | Reason |
|---|---|
| Express 5 | native async error propagation, replaces `express-async-errors` |
| Prisma + PostgreSQL | typed queries, migrations, replaces raw `mysql2` SQL strings |
| RTK Query | caching and request de-duplication without a second data library |
| Cloud Scheduler over node-cron | safe with autoscaling and scale-to-zero |
| Access token in memory, refresh in httpOnly cookie | no token in `localStorage`, CSRF-resistant refresh |
| Stripe Elements for card entry | card data never touches our servers (PCI SAQ-A) |
| Integration keys encrypted at rest (AES-256-GCM) | the source app stored them in plaintext columns |
| Passwords hashed with bcrypt | the source app stored plaintext passwords |
