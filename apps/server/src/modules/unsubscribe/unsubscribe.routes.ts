import { Router, type Request, type Response } from "express";
import { contactFromToken, unsubscribeEverywhere } from "../../domain/sending/unsubscribe.js";
import { limiter } from "../../middleware/rateLimit.js";

/**
 * The unsubscribe link in every pool email, served at /u/<token> on every sending domain (and /api/v1/u/ here).
 * GET unsubscribes straight away: no login, no confirmation step. POST is the RFC 8058 One-Click target that Gmail
 * and Outlook call from their own unsubscribe button.
 */
export const unsubscribeRouter = Router();
const unsubLimiter = limiter("unsubscribe", 60_000, 60);

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f4f0;color:#1c1a17;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:420px;background:#fff;border:1px solid #e6e1d8;border-radius:14px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#5b554c}</style></head><body><main>${body}</main></body></html>`;

const DONE = page("Unsubscribed", "<h1>You're unsubscribed</h1><p>You won't get any more emails from this sender, or from anyone else who sends through us.</p>");
const INVALID = page("Link not valid", "<h1>This link isn't valid</h1><p>It may have been cut short. Reply to the email with “unsubscribe” and you'll be removed.</p>");

unsubscribeRouter.get("/:token", unsubLimiter, async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const contactId = contactFromToken(String(req.params.token));
  if (!contactId || !(await unsubscribeEverywhere(contactId, "link"))) return res.status(404).type("html").send(INVALID);
  return res.type("html").send(DONE);
});

unsubscribeRouter.post("/:token", unsubLimiter, async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const contactId = contactFromToken(String(req.params.token));
  if (!contactId || !(await unsubscribeEverywhere(contactId, "one-click"))) return res.status(404).type("text").send("Not found");
  return res.type("text").send("Unsubscribed");
});
