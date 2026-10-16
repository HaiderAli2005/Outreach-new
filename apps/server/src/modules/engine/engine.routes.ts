import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./engine.controller.js";

export const engineRouter = Router();
engineRouter.post("/stop", requireManager, c.stop);
engineRouter.post("/start", requireManager, c.start);
