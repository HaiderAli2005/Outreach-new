import { Router } from "express";
import { requireManager, requireVerifiedEmail } from "../../middleware/auth.js";
import { limiter } from "../../middleware/rateLimit.js";
import * as c from "./onboarding.controller.js";

export const onboardingRouter = Router();
const aiLimiter = limiter("onboarding-ai", 10 * 60_000, 20);

onboardingRouter.get("/", c.state);
onboardingRouter.post("/start", requireManager, c.start);
onboardingRouter.patch("/", requireManager, c.update);
onboardingRouter.post("/analysis", requireManager, requireVerifiedEmail, aiLimiter, c.analyze);
onboardingRouter.post("/answers", requireManager, requireVerifiedEmail, aiLimiter, c.answers);
onboardingRouter.get("/market", requireVerifiedEmail, c.market);
onboardingRouter.get("/keywords", requireVerifiedEmail, c.keywords);
onboardingRouter.post("/preview", requireManager, requireVerifiedEmail, aiLimiter, c.preview);
onboardingRouter.get("/volume", c.volume);
onboardingRouter.post("/launch", requireManager, c.launch);
onboardingRouter.post("/first-run", requireManager, c.firstRun);
onboardingRouter.post("/skip-card", requireManager, c.skipCard);
onboardingRouter.post("/notify-capacity", requireManager, c.notifyCapacity);
