# SaaS architecture

## Does the product need organizations?

Yes. The source already had several people signing in to one shared workspace (owner plus team logins in
`037_create_users.sql` / `044_add_user_zain.sql`), and every piece of data (campaigns, leads, blocklist,
settings, Smartlead ids) belonged to that workspace, not to a person. Turning it into a product means many
such workspaces. So:

```text
User ──< Membership (OWNER | ADMIN | MEMBER) >── Organization
                                                   ├── Subscription ── Plan (volume limit, campaign limit)
                                                   ├── OrgSettings + IntegrationCredentials
                                                   └── all outreach data
```

A user can belong to several organizations (agency use case); the active one is carried in the access token
and switchable. Registration always creates a fresh organization with the user as OWNER.

## Models deliberately not created

| Suggested entity | Decision |
|---|---|
| Role / Permission tables | Three fixed roles cover every rule in the source; a role enum plus a permission matrix in code is simpler and testable. |
| Feature table | Plan features are a JSON column on `Plan`; limits that code enforces (`maxDailyVolume`, `maxCampaigns`) are real columns. |
| Usage (generic) | `UsageCounter` tracks the concrete meters the engine uses (Apollo enrichments, searches, verifications, AI calls). |

## Tenant isolation

* Every tenant-owned row has `organizationId` with a cascade delete from `Organization`.
* Composite unique keys include `organizationId` (contacts by email, blocklist values, companies by domain,
  weekly batches by week), so two tenants can prospect the same person without colliding, and one tenant's
  suppression list never suppresses another tenant's prospect.
* Repositories require `orgId`; there is no "find by id" that ignores the tenant.
* Webhooks carry no session, so they are routed explicitly: Smartlead events by
  `Campaign.smartleadCampaignId` / `OrgSettings.smartleadDefaultCampaignId`, Calendly and Apollo by the
  organization's random `webhookToken` in the URL. A contact is then looked up inside that organization only.
* Jobs iterate organizations and pass `orgId` down; they never run a cross-tenant query except to list the
  organizations to process.
* `test/tenant-isolation.test.ts` creates two organizations and asserts that every read and write endpoint
  returns 404 (not 403, to avoid confirming existence) for the other tenant's ids.

## Entitlements

`domain/entitlements.ts`:

* `hasActiveSubscription(org)`: ACTIVE or TRIALING. Sending, sourcing, auto-reply and launch require it.
* `dailyVolumeLimit(org)`: `min(plan.maxDailyVolume, subscription.dailyVolume)`, applied as a ceiling on
  `defaultDailySendCap` both when settings are saved and inside the send job.
* `campaignLimit(org)`: `plan.maxCampaigns` (Launch: 1 active campaign), checked on create and resume.

## Integration credentials

A tenant can bring its own Apollo, Smartlead, MillionVerifier and Slack credentials. When it has none, the
platform-level environment keys are used (the operator runs the shared infrastructure). Resolution order is
tenant credential → platform env → not configured. Tenant keys are encrypted with AES-256-GCM using
`ENCRYPTION_KEY` and are never returned in full.

## Scaling notes

* API and web are stateless containers; horizontal scaling on Cloud Run is safe because jobs are locked and
  triggered externally, rate limiting uses Redis when present, and sessions are tokens.
* Prisma connection pool size is set per instance (`connection_limit` in `DATABASE_URL`); with Cloud SQL use
  the Cloud SQL connector socket and keep `max instances × pool size` under the instance's connection limit.
* Third-party rate limits (Smartlead, Apollo, MillionVerifier) are enforced per process with Bottleneck, as in
  the source. Per-tenant work per job run is bounded, so one large tenant cannot hold the job lock for long.
