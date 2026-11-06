import type { Request, Response } from "express";
import { webOrigins } from "../../config/env.js";
import { readConnectState } from "../../integrations/googleMail.js";
import { logger } from "../../lib/logger.js";
import { finishGoogleConnect } from "../../domain/pool/manual.js";

/**
 * Google sends the operator's browser here after "Connect with Google" on a pool mailbox. The browser carries no
 * access token, so this route is public: the encrypted state (made by the authenticated admin request, valid for 10
 * minutes) is what proves an operator started it. Every outcome goes back to Admin > Domains as a plain message.
 */
export async function googleMailCallback(req: Request, res: Response) {
  const back = (params: Record<string, string>) => res.redirect(302, `${webOrigins[0] ?? ""}/admin/domains?${new URLSearchParams(params)}`);
  if (req.query.error) return back({ google: "error", message: req.query.error === "access_denied" ? "Google sign-in was cancelled." : `Google said: ${String(req.query.error)}` });
  const state = typeof req.query.state === "string" ? readConnectState(req.query.state) : null;
  if (!state) return back({ google: "error", message: "That Google sign-in expired or wasn't started here. Press Connect with Google again." });
  if (typeof req.query.code !== "string") return back({ google: "error", message: "Google sent no sign-in code. Try again." });
  try {
    const r = await finishGoogleConnect(req.query.code, state);
    return r.ok ? back({ google: "connected", mailbox: r.address }) : back({ google: "error", mailbox: r.address, message: `Connected, but the test sign-in failed: ${r.error ?? "unknown error"}` });
  } catch (e) {
    logger.warn({ mailboxId: state.mailboxId, err: (e as Error).message }, "google mail: connect failed after Google returned");
    return back({ google: "error", message: (e as Error).message || "Connecting with Google failed." });
  }
}
