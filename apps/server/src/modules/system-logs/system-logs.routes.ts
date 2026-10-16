import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./system-logs.controller.js";

export const systemLogsRouter = Router();
systemLogsRouter.get("/", c.list);
systemLogsRouter.post("/resolve", requireManager, c.resolve);
