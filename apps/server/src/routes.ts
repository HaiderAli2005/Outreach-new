import { Router } from "express";
import { requireAuth, requireOrg } from "./middleware/auth.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { organizationsRouter } from "./modules/organizations/organizations.routes.js";
import { create as createOrganization } from "./modules/organizations/organizations.controller.js";
import { billingPublicRouter, billingRouter } from "./modules/billing/billing.routes.js";
import { onboardingRouter } from "./modules/onboarding/onboarding.routes.js";
import { analysesRouter } from "./modules/analyses/analyses.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { engineRouter } from "./modules/engine/engine.routes.js";
import { inboxRouter } from "./modules/inbox/inbox.routes.js";
import { contactsRouter, dailyRouter } from "./modules/contacts/contacts.routes.js";
import { batchesRouter, publicBatchesRouter } from "./modules/batches/batches.routes.js";
import { campaignsRouter } from "./modules/campaigns/campaigns.routes.js";
import { blocklistRouter } from "./modules/blocklist/blocklist.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { sourcingRouter } from "./modules/sourcing/sourcing.routes.js";
import { systemLogsRouter } from "./modules/system-logs/system-logs.routes.js";
import { webhooksRouter } from "./modules/webhooks/webhooks.routes.js";
import { jobsRouter } from "./modules/jobs/jobs.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { googleMailCallback } from "./modules/admin/googleMail.callback.js";
import { inboxKitWebhook } from "./modules/admin/inboxkit.webhook.js";
import { unsubscribeRouter } from "./modules/unsubscribe/unsubscribe.routes.js";
import { launchRouter, vocabRouter } from "./modules/launch/launch.routes.js";
import { setupRouter } from "./modules/setup/setup.routes.js";
import { siteCheck } from "./modules/onboarding/siteCheck.controller.js";
import { limiter } from "./middleware/rateLimit.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/billing", billingPublicRouter);
apiRouter.use("/billing", billingRouter);
apiRouter.use("/webhooks", webhooksRouter);
apiRouter.use("/jobs", jobsRouter);
apiRouter.use("/public/batches", publicBatchesRouter);
apiRouter.use("/admin", adminRouter);
// Google returns the operator here after "Connect with Google" on a pool mailbox; the encrypted state is the proof.
apiRouter.get("/google-mail/callback", limiter("google-mail", 10 * 60_000, 30), googleMailCallback);
apiRouter.post("/inboxkit/webhook", limiter("inboxkit-webhook", 60_000, 300), inboxKitWebhook);
apiRouter.use("/u", unsubscribeRouter);
// Checked the moment a domain is entered, before sign-up, so a typo or an unreadable site is caught at step 1.
apiRouter.get("/public/site-check", limiter("site-check", 10 * 60_000, 40), siteCheck);
apiRouter.post("/organizations", requireAuth, createOrganization);

const tenant = Router();
tenant.use(requireAuth, requireOrg);
tenant.use("/organizations", organizationsRouter);
tenant.use("/onboarding", onboardingRouter);
tenant.use("/analyses", analysesRouter);
tenant.use("/dashboard", dashboardRouter);
tenant.use("/engine", engineRouter);
tenant.use("/inbox", inboxRouter);
tenant.use("/contacts", contactsRouter);
tenant.use("/daily", dailyRouter);
tenant.use("/batches", batchesRouter);
tenant.use("/campaigns", campaignsRouter);
tenant.use("/blocklist", blocklistRouter);
tenant.use("/settings", settingsRouter);
tenant.use("/launch", launchRouter);
tenant.use("/setup", setupRouter);
tenant.use("/lead-status-vocab", vocabRouter);
// /sending (the customer's own mailboxes) is parked: on the shared pool customers never see mailboxes.
tenant.use("/sourcing", sourcingRouter);
tenant.use("/system-logs", systemLogsRouter);
apiRouter.use(tenant);
