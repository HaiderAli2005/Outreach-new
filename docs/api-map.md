# API map

Base path `/api/v1`. JSON in and out except CSV exports.

## Conventions

Success:

```json
{ "data": { }, "meta": { "page": 1, "limit": 50, "total": 812 } }
```

Error:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Human readable", "details": [ ] }, "requestId": "…" }
```

* Status codes: 200/201/202/204, 400 validation, 401 unauthenticated, 402 subscription required,
  403 forbidden, 404 not found, 409 conflict, 422 business rule, 429 rate limited, 502 upstream, 503 not configured.
* Auth: `Authorization: Bearer <access token>`. Tenant: the organization is taken from the token's active
  membership (`X-Organization-Id` switches between organizations the user belongs to).
* Lists accept `page`, `limit`, `sort`, `order` and endpoint-specific filters; all validated with zod.

Legend: 🔓 public · 🔑 signed in · 🏢 organization member · 👑 org owner/admin · 🛡 platform admin · 🔏 shared secret

## Auth

| Method | Path | Access | Source equivalent |
|---|---|---|---|
| POST | `/auth/register` | 🔓 | — |
| POST | `/auth/login` | 🔓 rate limited | `POST /users/login` |
| POST | `/auth/refresh` | 🔓 refresh cookie | — |
| POST | `/auth/logout` | 🔓 | `POST /users/logout` |
| GET | `/auth/me` | 🔑 | `GET /users/logindetails` |
| GET | `/auth/oauth/google/start` | 🔓 | — |
| GET | `/auth/oauth/google/callback` | 🔓 | — |
| POST | `/auth/accept-invite` | 🔑 | — |
| POST | `/auth/challenge/status` | 🔓 rate limited | — (waiting screen polls; returns state only) |
| POST | `/auth/challenge/send-code` | 🔓 1 per minute per challenge | — (emails the 6-digit code) |
| POST | `/auth/challenge/code` | 🔓 rate limited | — (typed code: signs in for VERIFY, returns the reset token for RESET) |
| POST | `/auth/verify-email` | 🔓 rate limited | — (email link, with or without `n`) |
| POST | `/auth/verify-email/resend` | 🔓 signup claim cookie | — |
| POST | `/auth/claim` | 🔓 signup claim cookie | — (session for the screen that signed up, once verified) |
| POST | `/auth/password/forgot` | 🔓 10 per 15 min | — (same answer whether or not the email exists) |
| POST | `/auth/password/check` | 🔓 rate limited | — (reset link, with or without `n`) |
| POST | `/auth/password/reset` | 🔓 rate limited | — (needs an approved reset challenge; signs out every other session) |

## Organization

| Method | Path | Access |
|---|---|---|
| GET | `/organizations/current` | 🏢 |
| PATCH | `/organizations/current` | 👑 |
| GET | `/organizations/current/members` | 🏢 |
| POST | `/organizations/current/members` | 👑 invite |
| PATCH | `/organizations/current/members/:id` | 👑 change role |
| DELETE | `/organizations/current/members/:id` | 👑 |

## Onboarding

| Method | Path | Access | Source equivalent |
|---|---|---|---|
| GET | `/onboarding` | 🏢 | — |
| PATCH | `/onboarding` | 👑 (facts, groups, senders, volume, warmup, inboxes per domain, provider, fastStart) | — |
| POST | `/onboarding/analysis` | 👑 | `POST /config/brand-setup` |
| POST | `/onboarding/preview` | 👑 | personalize + followups |
| GET | `/onboarding/domains/ideas` | 👑 | — |
| PUT | `/onboarding/domains` | 👑 (selected domains + inboxes per domain) | — |
| POST | `/onboarding/launch` | 👑 | `POST /config/brand-apply` + `POST /smartlead/provision` |

## Billing

| Method | Path | Access |
|---|---|---|
| GET | `/billing/plans` | 🔓 |
| GET | `/billing/config` | 🔓 publishable key + enabled flag |
| GET | `/billing/credits` | 🏢 balance, runway, health, activity |
| GET | `/billing/topup-options` | 🏢 suggested top-ups for the daily budget (`?budget=` to preview) |
| POST | `/billing/topups` | 👑 PaymentIntent, idempotent (Idempotency-Key header) |
| POST | `/billing/trial` | 👑 free $10, once |
| DELETE | `/billing/card` | 👑 removes saved cards, switches auto-reload off |
| POST | `/billing/close` | 👑 closes the account |
| GET | `/billing/payments` | 🏢 |
| GET | `/billing/payments/:id/confirm` | 👑 an auto-reload waiting for 3-D Secure |
| POST | `/billing/webhook` | 🔏 Stripe signature, raw body |

## Engine

| Method | Path | Access | Source |
|---|---|---|---|
| GET | `/dashboard/cockpit` | 🏢 | `GET /dashboard/cockpit` |
| GET | `/dashboard/nav-counts` | 🏢 | `GET /dashboard/nav-counts` |
| POST | `/engine/stop` | 👑 | `POST /config/stop` |
| POST | `/engine/start` | 👑 | `POST /config/start` |
| GET | `/inbox` | 🏢 | `GET /inbox` |
| GET | `/inbox/:contactId` | 🏢 | `GET /inbox/:id` |
| POST | `/inbox/:contactId/reply` | 🏢 | `POST /inbox/:id/reply` |
| POST | `/inbox/:contactId/deal-closed` | 🏢 | `POST /inbox/:id/deal-closed` |
| POST | `/inbox/:contactId/handled` | 🏢 | `POST /inbox/:id/handled` |
| DELETE | `/inbox/:contactId` | 🏢 | `DELETE /inbox/:id` |
| GET | `/contacts` | 🏢 | `GET /contacts` |
| GET | `/contacts/stats` | 🏢 | `GET /contacts/stats` |
| GET | `/contacts/export` | 🏢 CSV | `GET /contacts/export` |
| POST | `/contacts/import` | 🏢 | `POST /contacts/import` |
| GET | `/contacts/:id` | 🏢 | `GET /contacts/:id` |
| GET | `/daily` · `/daily/export` | 🏢 | `GET /daily` · `/daily/export` |
| GET | `/batches` · `/batches/pending` · `/batches/:id` | 🏢 | same |
| POST | `/batches/:id/exclude` · `/batches/:id/approve` | 👑 | same |
| GET | `/public/batches/approve` | 🔏 HMAC link | `GET /slack/approve` |
| GET | `/campaigns` | 🏢 | `GET /campaigns` |
| POST | `/campaigns` | 👑 plan limit | (disabled in source) |
| GET | `/campaigns/:id` | 🏢 | `GET /campaigns/:id` |
| PATCH | `/campaigns/:id` | 👑 draft/paused only | (disabled in source) |
| PATCH | `/campaigns/:id/status` | 👑 | `PATCH /campaigns/:id/status` |
| GET | `/campaigns/:id/export` | 🏢 CSV | `GET /campaigns/:id/export` |
| GET | `/blocklist` | 🏢 | `GET /blocklist` |
| POST | `/blocklist` | 🏢 | `POST /blocklist` |
| DELETE | `/blocklist/:id` | 👑 | `DELETE /blocklist/:id` |
| POST | `/blocklist/import` | 🏢 | `POST /blocklist/import` |
| POST | `/blocklist/restore` | 🏢 | `POST /blocklist/restore` |
| GET | `/blocklist/export` | 🏢 CSV | `GET /blocklist/export` |
| GET | `/settings` · PATCH `/settings` | 🏢 / 👑 | `GET/PATCH /config` |
| PUT | `/settings/credentials/:provider` · DELETE | 👑 | key fields of `PATCH /config` |
| GET | `/settings/autopilot-status` | 🏢 | `GET /config/autopilot` |
| POST | `/settings/auto-reply/kill` | 👑 | `POST /config/auto-reply/kill` |
| GET | `/settings/auto-reply/metrics` | 🏢 | `GET /config/auto-reply/metrics` |
| POST | `/settings/verify-email` | 👑 | `GET /config/verify` |
| GET | `/sending/mailboxes` | 👑 | `GET /smartlead/mailboxes` |
| POST | `/sending/provision` | 👑 | `POST /smartlead/provision` |
| POST | `/sourcing/search` | 👑 | `POST /apollo/search` |
| POST | `/sourcing/import` | 👑 | `POST /apollo/import` |
| GET | `/sourcing/usage` | 🏢 | `GET /apollo/usage` |
| GET | `/system-logs` · POST `/system-logs/resolve` | 🏢 / 👑 | `/dashboard/system-log(/resolve)` |

## Webhooks and jobs

| Method | Path | Access | Source |
|---|---|---|---|
| POST | `/webhooks/smartlead?token=` | 🔏 | `POST /webhooks/smartlead` |
| POST | `/webhooks/calendly/:orgToken?token=` | 🔏 | `POST /webhooks/calendly` |
| POST | `/webhooks/apollo/:orgToken?token=` | 🔏 | `POST /webhooks/apollo` |
| GET | `/jobs` | 🔏 | `GET /jobs` |
| POST | `/jobs/:name/run` | 🔏 `X-Jobs-Secret` | `POST /jobs/:name/run` |

## Platform admin

| Method | Path |
|---|---|
| GET | `/admin/overview` |
| GET | `/admin/users` · PATCH `/admin/users/:id` |
| GET | `/admin/organizations` · GET/PATCH `/admin/organizations/:id` |
| GET | `/admin/subscriptions` |
| GET | `/admin/payments` · POST `/admin/payments/:id/refund` |
| GET | `/admin/webhook-events` |
| GET | `/admin/system-logs` |

## Health

`GET /healthz` (liveness, no dependencies) and `GET /api/v1/health` (database and Redis checks; 503 when the
database is unreachable).

## Added during the frontend build

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/onboarding/answers` | org owner/admin, AI rate limit | Used when the site can't be read. Builds the facts and buyer groups from three answers (sell, who, countries). |
| GET | `/onboarding/market?refresh=1` | org member | Apollo counts per buyer group (all and verified emails) plus a 25 person sample per group. Cached 24h per set of enabled groups. |
| GET | `/onboarding/keywords?group=seg_1` | org member | People each keyword finds on its own inside one audience, with a `none` or `broad` flag. Cached 24h. |
| GET | `/analyses/:id/stream?from=<seq>` | org member | Server-Sent Events for one analysis run: `run.start`, `step.start`, `step.log`, `item.found`, `step.done`, `run.done`, `run.error`, plus a heartbeat every 15s. Replays stored events after `from` (or `Last-Event-ID`) and then follows the run. Never starts or repeats work. |
| GET | `/orgs/:id/provisioning/stream` | org member, own org only | The setup checklist after payment (`buy_domains`, `dns`, `mailboxes`, `warmup`, `campaign`) in the same event shape. Ends once sending starts. |
| POST | `/organizations` | signed in, no organization needed | Creates a workspace (and starts setup when a domain is given). Up to 5 owned workspaces per user. |
| POST | `/webhooks/smartlead/:orgToken` | the organization's webhook token | Per-tenant URL. Events for a campaign that belongs to another organization are ignored. |

`/webhooks/calendly/:orgToken` and `/webhooks/apollo/:orgToken` also accept the organization token alone,
so tenants can configure them without the platform secret. `GET /organizations/current` hides the webhook
token from `MEMBER` users.
