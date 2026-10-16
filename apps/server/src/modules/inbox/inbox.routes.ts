import { Router } from "express";
import * as c from "./inbox.controller.js";
import { ctx } from "../../lib/http.js";
import { streamInbox } from "./inbox.stream.js";

export const inboxRouter = Router();
inboxRouter.get("/", c.list);
// Before /:contactId, or "stream" would be read as a contact id.
inboxRouter.get("/stream", (req, res) => streamInbox(req, res, ctx(req).orgId));
inboxRouter.get("/:contactId", c.thread);
inboxRouter.post("/:contactId/reply", c.reply);
inboxRouter.post("/:contactId/deal-closed", c.dealClosed);
inboxRouter.post("/:contactId/handled", c.handled);
inboxRouter.post("/:contactId/draft/discard", c.discardDraft);
inboxRouter.post("/:contactId/intent", c.correctIntent);
inboxRouter.delete("/:contactId", c.remove);
