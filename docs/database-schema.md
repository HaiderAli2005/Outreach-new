# Database schema

PostgreSQL 16 via Prisma. The authoritative definition is `apps/server/prisma/schema.prisma`; this document
explains the shape and the reasons behind it.

## Source → new mapping

| outreach-saas (MySQL) | New (PostgreSQL) | Change |
|---|---|---|
| `users` (plaintext `password`) | `User` | bcrypt `passwordHash`, nullable for OAuth-only users, `isPlatformAdmin` |
| — | `Organization`, `Membership` | tenancy (the source was single-tenant) |
| `settings` (singleton row, id = 1) | `OrgSettings` (one per organization) | API keys moved out to `IntegrationCredential` |
| `settings.*_api_key` columns | `IntegrationCredential` | AES-256-GCM ciphertext + last 4 characters |
| `campaigns` | `Campaign` | `organizationId`, enum status, `smartleadCampaignId` unique (webhook routing) |
| `companies` | `Company` | unique per (organization, domain) |
| `contacts` | `Contact` | unique per (organization, normalized email); enum status; denormalised thread fields |
| `messages` | `Message` | `organizationId`, enum direction |
| `blocklist` | `BlocklistEntry` | unique per (organization, type, value); enum reason |
| `weekly_batches` | `WeeklyBatch` | unique per (organization, week) |
| `auto_reply_queue` | `AutoReplyQueue` | unchanged semantics |
| `auto_reply_shadow_log` | `AutoReplyDecision` | |
| `system_logs` | `SystemLog` | nullable `organizationId` for platform-level events |
| `usage_counters` | `UsageCounter` | per organization per day |
| `job_locks` | Redis `SET NX PX` / `pg_try_advisory_lock` | no table needed |
| `smartlead_sequence_sync`, `sourcing_log`, `apollo_discards`, `_migrations` | not carried | operational state for one deployment; Prisma owns migrations |
| — | `Plan`, `Subscription`, `Payment`, `Refund`, `Invoice`, `WebhookEvent` | billing |
| — | `Onboarding`, `SendingDomain`, `Mailbox` | the design's setup flow |
| — | `RefreshToken`, `OAuthAccount` | auth |

## Entity overview

```text
User ─< Membership >─ Organization ─┬─ OrgSettings (1:1)
     ─< OAuthAccount                ├─ Onboarding (1:1)
     ─< RefreshToken                ├─ Subscription (1:1) ─ Plan
                                    ├─< Payment ─< Refund
                                    ├─< Invoice
                                    ├─< IntegrationCredential
                                    ├─< Campaign ─< Contact ─< Message
                                    ├─< Company
                                    ├─< WeeklyBatch ─< Contact
                                    ├─< BlocklistEntry
                                    ├─< AutoReplyQueue, AutoReplyDecision
                                    ├─< SendingDomain ─< Mailbox
                                    ├─< SystemLog
                                    └─< UsageCounter
WebhookEvent (global, unique per provider + external id)
```

## Denormalised thread fields on `Contact`

The source computed "who sent the last message" with a correlated subquery
(`SELECT direction FROM messages ... ORDER BY created_at DESC LIMIT 1`) inside every inbox list, count and
badge query — five of them per inbox page load. The rebuild keeps `lastMessageAt`, `lastMessageDirection`,
`lastMessagePreview`, `messageCount` and `hasInbound` on the contact, written in the same transaction as the
message by `messages.repository.create`. The inbox predicates become plain indexed column filters.

## Indexes

Every tenant-owned table leads its indexes with `organizationId`, matching how every query filters.
Notable ones:

* `Contact(organizationId, emailNormalized)` unique: the de-duplication key (source: `uk_contacts_email`).
* `Contact(organizationId, status)`, `(organizationId, campaignId)`, `(organizationId, batchId)`,
  `(organizationId, companyDomain)`: list filters, campaign counts, batch stats, per-company cap.
* `Contact(organizationId, lastMessageAt)`: inbox ordering.
* `Message(organizationId, contactId, createdAt)`: thread reads.
* `Message(organizationId, direction, createdAt)`: sent-today and heartbeat aggregates.
* `BlocklistEntry(organizationId, entryType, value)` unique: suppression lookups.
* `AutoReplyQueue(organizationId, status, sendAfter)`: dispatcher polling.
* `WebhookEvent(provider, externalId)` unique: webhook idempotency.

## Constraints and transactions

* Registration (user + organization + membership + settings) is one transaction.
* Recording a message and updating the contact's thread fields is one transaction.
* Batch approval, lead import inserts and restore are transactions.
* Webhook processing claims the `WebhookEvent` row first; a duplicate delivery hits the unique constraint
  and is acknowledged without being processed again.
* Money is stored in integer cents.

## Pagination

List endpoints use offset pagination with a hard `limit` ceiling (100 for inbox, 500 for leads and
blocklist) and always return `total`. CSV exports stream in pages of 1,000 rows instead of loading
100,000 rows into memory as the source did.
