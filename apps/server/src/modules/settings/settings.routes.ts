import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./settings.controller.js";

export const settingsRouter = Router();
settingsRouter.get("/", c.view);
settingsRouter.patch("/", requireManager, c.update);
settingsRouter.put("/credentials/:provider", requireManager, c.saveCredential);
settingsRouter.delete("/credentials/:provider", requireManager, c.removeCredential);
settingsRouter.get("/autopilot-status", c.autopilot);
settingsRouter.post("/verify-email", requireManager, c.verifyEmail);
