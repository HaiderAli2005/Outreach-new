# Deployment on Google Cloud

## Services

| Piece | Google Cloud product | Notes |
|---|---|---|
| API (`apps/server`) | Cloud Run service `aperture-api` | `infra/Dockerfile.api --target runtime`. Keep `--min-instances 1` and `--no-cpu-throttling` so reply classification can finish after a webhook response. |
| Web (`apps/client`) | Cloud Run service `aperture-web` | `infra/Dockerfile.web`. Next.js standalone server. |
| Database | Cloud SQL for PostgreSQL 16 | Private IP or the Cloud SQL connector (`--set-cloudsql-instances`). |
| Migrations | Cloud Run job `aperture-migrate` | `infra/Dockerfile.api --target migrate` runs `prisma migrate deploy` before each API deploy. |
| Redis (optional) | Memorystore for Redis | Rate-limit store, login throttling and job locks. Without it the API falls back to in-memory limits and Postgres advisory locks. Needs a Serverless VPC connector. |
| Secrets | Secret Manager | Every sensitive env var is mounted with `--set-secrets`. `infra/scripts/secrets.sh` creates them. |
| Mailbox watcher | Cloud Run worker pool `aperture-watcher`, or a small always-on VM | Same image as the API, command `npm run watcher -w apps/server`. Holds one IMAP IDLE connection per sending mailbox so replies are read within seconds; the 2-minute `mailbox-poll` stays as the safety net. It serves no HTTP, so it is not a Cloud Run service; run exactly one instance per shard, always on. Past ~300 mailboxes add services with `MAILBOX_WATCH_SHARD=0/2`, `1/2`, …; leave `MAILBOX_WATCH` unset on the API. With Redis, its nudges reach the live inbox on every API instance at once; without, within 5 seconds. |
| Background jobs | Cloud Scheduler | `infra/scripts/scheduler.sh` creates one HTTP job per entry in `apps/server/src/jobs/registry.ts`, calling `POST /api/v1/jobs/:name/run` with `X-Jobs-Secret`. |
| File storage | Cloud Storage | Not needed today: CSV imports are read in the request and exports are streamed. Attachments stay as Smartlead URLs. |
| Images | Artifact Registry repo `aperture` | Used by `infra/cloudbuild.yaml`. |

## Routing

Two options:

1. **One domain behind an HTTPS load balancer** (recommended). Route `/api/*` to `aperture-api` and
   everything else to `aperture-web`. Build the web image with `API_PROXY=off`. Cookies stay first-party
   and the refresh cookie's `SameSite=Strict` works without extra setup.
2. **Web proxies the API.** Build the web image with `API_ORIGIN=https://<api-service-url>`; Next.js rewrites
   `/api/*` to the API. `API_ORIGIN` is read at build time because Next.js compiles rewrites.

Set `WEB_ORIGIN` on the API to the public web URL (comma separated if more than one). CORS and the
OAuth redirect use it. Set `PUBLIC_API_URL` to the public URL the API is reached at.

## First deploy

```bash
export PROJECT=my-project REGION=europe-west1
gcloud artifacts repositories create aperture --repository-format docker --location $REGION
PROJECT=$PROJECT infra/scripts/secrets.sh
gcloud builds submit --config infra/cloudbuild.yaml \
  --substitutions _REGION=$REGION,_SQL_INSTANCE=$PROJECT:$REGION:aperture,_VPC_CONNECTOR=aperture-connector,_API_ORIGIN=https://api.example.com
PROJECT=$PROJECT REGION=$REGION API_URL=https://api.example.com JOBS_SECRET=... infra/scripts/scheduler.sh
```

Then, once:

- Create the first platform admin: run the migrate image as a one-off Cloud Run job with the command
  `npx tsx prisma/seed.ts` and `ADMIN_EMAIL` / `ADMIN_PASSWORD` set.
- Add the Stripe webhook endpoint `https://<api>/api/v1/billing/webhook` (the API host directly, never through a
  frontend rewrite) for exactly these nine events: `setup_intent.succeeded`, `setup_intent.setup_failed`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `payment_intent.processing`, `payment_intent.requires_action`, `charge.refunded`, `charge.dispute.created` and
  `charge.dispute.closed`. No `customer.subscription.*` or `invoice.*` events. Store its signing secret as
  `STRIPE_WEBHOOK_SECRET`. There are no Stripe Products or Prices to create; see `docs/stripe.md`.
- Email (optional, turns on email verification and password reset): add `--update-env-vars
  MAIL_HOST=smtp.mailgun.org,MAIL_PORT=587,MAIL_USER=postmaster@mg.<domain>,MAIL_FROM=Aperture <no-reply@mg.<domain>>`
  and `--update-secrets MAIL_PASS=MAIL_PASS:latest` to the API service.
- Google OAuth: authorised redirect URI `https://<public web or api domain>/api/v1/auth/oauth/google/callback`.

## Environment

`apps/server/.env.example` and `apps/client/.env.example` list every variable with a description. The API
refuses to start in production when a required secret is missing or still a placeholder.

## Verification status

The API production build (`npm run build -w apps/server` then `node dist/index.js`) and the web production
build (`next build`, standalone output) were run and served traffic in the authoring environment. The
Docker images themselves could not be built there because Docker Hub rate-limited the `node:22-slim`
pull, so run `docker build -f infra/Dockerfile.api --target runtime .` and
`docker build -f infra/Dockerfile.web .` once in CI before the first deploy.
