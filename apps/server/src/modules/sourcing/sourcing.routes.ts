import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import { limiter } from "../../middleware/rateLimit.js";
import * as c from "./sourcing.controller.js";

export const sourcingRouter = Router();
sourcingRouter.post("/search", requireManager, limiter("sourcing", 60_000, 20), c.search);
sourcingRouter.post("/import", requireManager, limiter("sourcing-import", 60_000, 5), c.importNow);
sourcingRouter.get("/usage", c.usage);
