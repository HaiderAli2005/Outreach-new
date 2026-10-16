import { Router } from "express";
import { limiter } from "../../middleware/rateLimit.js";
import * as c from "./webhooks.controller.js";

export const webhooksRouter = Router();
webhooksRouter.use(limiter("webhooks", 60_000, 600));
webhooksRouter.post("/calendly/:orgToken", c.calendly);
webhooksRouter.post("/apollo/:orgToken", c.apollo);
