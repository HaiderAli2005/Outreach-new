#!/usr/bin/env bash
# Creates or updates one Cloud Scheduler job per background job in apps/server/src/jobs/registry.ts.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT}"
REGION="${REGION:-europe-west1}"
API_URL="${API_URL:?set API_URL, e.g. https://aperture-api-xxxx.a.run.app}"
JOBS_SECRET="${JOBS_SECRET:?set JOBS_SECRET to the same value the API uses}"
TZ_NAME="${TZ_NAME:-Etc/UTC}"

JOBS=(
  "send|*/30 * * * *"
  "blocklist|17 2 * * *"
  "reply-sync|*/5 * * * *"
  "mailbox-poll|*/2 * * * *"
  "soft-bounce-retry|*/5 * * * *"
  "follow-ups|*/5 * * * *"
  "first-touches|*/5 * * * *"
  "sourcing|0 */2 * * *"
  "reverify|0 3 * * *"
  "batch-notify|0 */3 * * *"
  "report-daily|0 18 * * 1-5"
  "report-weekly|0 8 * * 1"
  "report-monthly|0 8 1 * *"
  "billing-sync|0 * * * *"
  "auto-reload|*/10 * * * *"
  "capacity-notify|45 * * * *"
  "pool-mailbox-health|15 * * * *"
  "pool-domain-health|20 * * * *"
  "pool-warmup|25 * * * *"
  "pool-rollup|10 0 * * *"
  "pool-risk|20 0 * * *"
  "pool-snapshot|30 0 * * *"
  "pool-ewma|40 0 * * 1"
  "pool-reorder-check|50 0 * * *"
  "pool-retire-quiet|0 1 * * *"
  "pool-dns|5 2 * * *"
  "pool-seed-test|35 2 * * *"
  "pool-dilution|45 0 * * *"
  "pool-console|*/15 * * * *"
  "credits-stale-holds|15 1 * * *"
  "first-runs|* * * * *"
  "inbox-history|*/30 * * * *"
)
# Retired: credits-refill, infra-provision, infra-release (shared pool) and auto-reply-dispatch (replies are drafts
# now; nothing sends a reply on a timer). The API also reads the
# mailboxes in-process every 2 minutes; mailbox-poll here is the backstop when it scales to zero. Delete their Cloud
# Scheduler jobs once: gcloud scheduler jobs delete aperture-<name> --project "$PROJECT" --location "$REGION"

for entry in "${JOBS[@]}"; do
  name="${entry%%|*}"
  schedule="${entry#*|}"
  args=(--project "$PROJECT" --location "$REGION" --schedule "$schedule" --time-zone "$TZ_NAME"
    --uri "$API_URL/api/v1/jobs/$name/run" --http-method POST
    --headers "X-Jobs-Secret=$JOBS_SECRET,Content-Type=application/json" --attempt-deadline 900s)
  if gcloud scheduler jobs describe "aperture-$name" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "aperture-$name" "${args[@]}"
  else
    gcloud scheduler jobs create http "aperture-$name" "${args[@]}"
  fi
done
