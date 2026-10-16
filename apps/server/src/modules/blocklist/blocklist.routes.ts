import { Router } from "express";
import { requireManager } from "../../middleware/auth.js";
import * as c from "./blocklist.controller.js";

export const blocklistRouter = Router();
blocklistRouter.get("/", c.list);
blocklistRouter.get("/export", c.exportCsv);
blocklistRouter.post("/", c.add);
blocklistRouter.post("/import", c.importList);
blocklistRouter.post("/restore", c.restore);
blocklistRouter.delete("/:id", requireManager, c.remove);
