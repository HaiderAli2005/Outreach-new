import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./campaigns.controller.js";

export const campaignsRouter = Router();
campaignsRouter.get("/", c.list);
campaignsRouter.post("/", requireManager, c.create);
campaignsRouter.get("/:id/export", c.exportCampaign);
campaignsRouter.patch("/:id/status", requireManager, c.setStatus);
campaignsRouter.get("/:id", c.get);
campaignsRouter.patch("/:id", requireManager, c.update);
