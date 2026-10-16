import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./batches.controller.js";

export const batchesRouter = Router();
batchesRouter.get("/", c.list);
batchesRouter.get("/pending", c.pending);
batchesRouter.get("/:id", c.get);
batchesRouter.post("/:id/approve", requireManager, c.approve);
batchesRouter.post("/:id/exclude", requireManager, c.exclude);

export const publicBatchesRouter = Router();
publicBatchesRouter.get("/approve", c.approveLink);
