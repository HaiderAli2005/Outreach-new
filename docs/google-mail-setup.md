# Google mailboxes without app passwords

Aperture can now send from Google Workspace mailboxes **without 2-step verification and without app passwords**. It signs in with Google's OAuth (XOAUTH2) instead of a password. Password mailboxes (Infraforge, Mailforge, Zoho, anything with SMTP/IMAP) keep working exactly as before.

There are two ways to connect a Google mailbox:

| Way | When to use it | Clicks per mailbox |
|---|---|---|
| **Workspace sign-in** (service account + domain-wide delegation) | You have the **Google Admin** login of the Workspace the mailboxes are in (EmailAstra and some other sellers give it) | **None.** One setting per Workspace, then every mailbox in it works |
| **Connect with Google** (one mailbox) | You only have the mailbox's own login, no admin | Sign in as the mailbox once and press Allow |

Workspace sign-in is the scalable one. Use Connect with Google only when you have no admin access.

---

## Part 1: one-time setup in Google Cloud (about 10 minutes)

You do this **once for Aperture**, not per Workspace.

1. Go to **console.cloud.google.com** and create a project, for example `aperture-mail`.
2. **Turn on the Gmail API:** APIs & Services → Library → search "Gmail API" → Enable.
3. **Create the service account:** IAM & Admin → Service accounts → Create service account → name it `aperture-mail` → Create and continue → Done (no roles needed).
4. **Make its key:** open the service account → Keys → Add key → Create new key → **JSON** → Create. A `.json` file downloads. Keep it private, it is a password for every Workspace that allows it.
5. **Give the key to Aperture**, one of two ways:
   - **Easiest:** Admin → Domains → **Google sign-in** panel → paste the whole JSON file → **Save key**. It is kept in the secret store (Google Secret Manager in production) and never shown again.
   - Or set the server variable `GOOGLE_MAIL_SERVICE_ACCOUNT` to the JSON (or its base64).
6. The Google sign-in panel now shows Aperture's **client ID** (a long number). You give this to each Workspace's admin in Part 2.

## Part 2: once per Workspace you buy mailboxes in (2 minutes)

Log in to **admin.google.com** with that Workspace's **admin** account, then:

1. **Security** → **Access and data control** → **API controls**.
2. **Manage domain-wide delegation** → **Add new**.
3. **Client ID:** paste Aperture's client ID (the Copy button in the panel).
4. **OAuth scopes:** `https://mail.google.com/`
5. **Authorize.** It can take a few minutes, sometimes up to an hour, before Google accepts it.

Also check in the same admin console that **IMAP is on**: Apps → Google Workspace → Gmail → End User Access → POP and IMAP access → IMAP on.

## Part 3: add the mailboxes in Aperture

1. Admin → Domains → **Add warmed domain**.
2. Where the mailboxes are hosted: **Google, no password**.
3. Type each mailbox's address and name. There is no password field.
4. **Add domain.** Aperture signs each mailbox in through the service account. If the Workspace admin hasn't done Part 2 yet, the mailbox shows **Can't sign in** with the exact steps; do Part 2, then press **Test sign-in**.

Already added a Google mailbox with an app password? Press **Use Workspace sign-in** on its row to switch it.

---

## Connect with Google, one mailbox (no admin access)

This uses a normal Google OAuth client. The existing Google sign-in client works (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), or set a separate one with `GOOGLE_MAIL_CLIENT_ID` / `GOOGLE_MAIL_CLIENT_SECRET`.

1. Google Cloud → APIs & Services → **Credentials** → your OAuth client (type **Web application**).
2. **Authorized redirect URIs** → add exactly the URL shown in the Google sign-in panel, by default `https://YOUR-APP/api/v1/google-mail/callback`. Locally: `http://localhost:3100/api/v1/google-mail/callback`.
3. OAuth consent screen → Data access / Scopes → add `https://mail.google.com/`.
4. In Aperture, on the mailbox row press **Connect with Google**, sign in **as that mailbox**, press Allow. You come back to Admin → Domains with a message.

**Google's limits on this way (important):**

- `https://mail.google.com/` is a **restricted** scope. While the app's consent screen is in **Testing**, only the up to 100 **test users** you list can connect, and every connection **ends after 7 days**. You'd have to press Connect again weekly.
- To remove those limits Google requires **app verification**, including a paid yearly **security assessment** for restricted scopes. That is why Workspace sign-in (Part 1–3), which needs no verification, is the main road.

---

## What changed in the code

| File | Change |
|---|---|
| `apps/server/src/integrations/googleMail.ts` | New. Service account JWT signing (no new library), token exchange and caching (tokens renewed 5 minutes before their hour ends), Connect with Google URL and callback, plain-English errors |
| `apps/server/src/domain/sending/transport/types.ts` | `MailboxCreds.accessToken` |
| `apps/server/src/domain/sending/transport/index.ts` | `credsFor` makes an access token for Google mailboxes |
| `apps/server/src/domain/sending/transport/smtp.ts` | SMTP and IMAP sign in with XOAUTH2 when there is a token; the SMTP pool is rebuilt when the token is renewed |
| `apps/server/src/domain/pool/manual.ts` | `auth: "google"` mailboxes (no password, Gmail servers), status, save key, switch to Workspace sign-in, Connect with Google |
| `apps/server/src/modules/admin/domains.admin.ts`, `admin.routes.ts` | `GET /admin/google-mail`, `PUT /admin/google-mail/service-account`, `POST /admin/mailboxes/:id/google/workspace`, `POST /admin/mailboxes/:id/google/connect` |
| `apps/server/src/modules/admin/googleMail.callback.ts`, `routes.ts` | Public `GET /api/v1/google-mail/callback` (protected by an encrypted, 10-minute state) |
| `apps/server/src/config/env.ts`, `.env.example` | `GOOGLE_MAIL_SERVICE_ACCOUNT`, `GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET`, `GOOGLE_MAIL_REDIRECT_URI` |
| `apps/client/src/app/admin/domains/page.tsx`, `store/api.ts`, `lib/types.ts` | Google sign-in panel, "Google, no password" host option, Connect with Google / Use Workspace sign-in buttons |
| `apps/server/test/googleMail.test.ts` | 11 unit tests (no database) |
| `apps/server/test/googleMailAdmin.test.ts` | 6 end-to-end admin tests (need the test database) |

No database migration: how a mailbox signs in is kept in the existing `mailbox.provider` column (`manual`, `google-workspace`, `google-oauth`), and the secret store holds `{"kind":"google-workspace"}` or `{"kind":"google-oauth","rt":"…"}` instead of a password.

## Run the tests

```
npm run db:up
npm test -w apps/server -- googleMail
```

## Things to know

- **Sending limits:** Google Workspace allows about 2,000 emails a day per user, far above Aperture's 30. Keep the 30 a day cap.
- **Gmail's own rules still apply:** SPF, DKIM (Google's selector is usually `google`), DMARC, spam rate under 0.1%.
- **Google can suspend Workspace accounts** used for heavy cold email. Keep volume low per mailbox and keep a mix of providers in the pool.
- **Microsoft 365** mailboxes are not covered yet. Microsoft is retiring password SMTP (off by default in 2026, removed in 2027), so the same OAuth approach will be needed there next.
