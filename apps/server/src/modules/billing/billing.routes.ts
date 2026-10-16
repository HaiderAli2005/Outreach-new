import { Router } from "express";
import { requireAuth, requireManager, requireOrg } from "../../middleware/auth.js";
import * as c from "./billing.controller.js";

export const billingPublicRouter = Router();
billingPublicRouter.get("/plans", c.plans);
billingPublicRouter.get("/config", c.config);
billingPublicRouter.post("/webhook", c.webhook);

export const billingRouter = Router();
billingRouter.use(requireAuth, requireOrg);
billingRouter.get("/credits", c.credits);
billingRouter.post("/topups", requireManager, c.topup);
billingRouter.post("/setup-intents", requireManager, c.setup);
billingRouter.delete("/card", requireManager, c.removeCard);
billingRouter.post("/close", requireManager, c.close);
billingRouter.post("/reverify", requireManager, c.reverify);
billingRouter.get("/topup-options", c.topupOptions);
billingRouter.get("/payments/:id/confirm", requireManager, c.confirmPayment);
billingRouter.get("/payments", c.payments);
