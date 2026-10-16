import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./organizations.controller.js";

export const organizationsRouter = Router();

organizationsRouter.get("/current", c.current);
organizationsRouter.patch("/current", requireManager, c.update);
organizationsRouter.delete("/current", c.destroy);
organizationsRouter.get("/current/members", c.members);
organizationsRouter.post("/current/members", requireManager, c.invite);
organizationsRouter.patch("/current/members/:id", requireManager, c.changeRole);
organizationsRouter.delete("/current/members/:id", requireManager, c.remove);
