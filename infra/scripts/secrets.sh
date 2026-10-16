#!/usr/bin/env bash
# Creates each Secret Manager secret the API reads. Values are prompted, never echoed.
set -euo pipefail
PROJECT="${PROJECT:?set PROJECT}"
SECRETS=(DATABASE_URL REDIS_URL WEB_ORIGIN PUBLIC_API_URL JWT_ACCESS_SECRET ENCRYPTION_KEY JOBS_SECRET WEBHOOK_SECRET APPROVE_LINK_SECRET
  STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI OPENAI_API_KEY)
for name in "${SECRETS[@]}"; do
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    echo "exists: $name"
    continue
  fi
  read -r -s -p "$name (leave empty to skip): " value; echo
  [ -z "$value" ] && continue
  printf '%s' "$value" | gcloud secrets create "$name" --project "$PROJECT" --replication-policy automatic --data-file=-
done
