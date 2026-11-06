import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./setup.controller.js";

/** Setup: the active campaign's business profile, targeting and email sequence. Sending schedule is in /settings. */
export const setupRouter = Router();
setupRouter.get("/profile", c.profile);
setupRouter.put("/profile", requireManager, c.saveProfile);
setupRouter.get("/sequence", c.sequence);
setupRouter.put("/sequence", requireManager, c.saveSequenceHandler);
setupRouter.get("/targeting", c.targeting);
setupRouter.post("/targeting/check", requireManager, c.targetingCheck);
setupRouter.put("/targeting", requireManager, c.saveTargetingHandler);
setupRouter.post("/targeting/audiences", requireManager, c.createAudienceHandler);
setupRouter.post("/targeting/audiences/preview", requireManager, c.previewAudienceHandler);
setupRouter.post("/targeting/audiences/import", requireManager, c.importAudiencesHandler);
