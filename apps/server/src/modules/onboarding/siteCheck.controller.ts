import type { Request, Response } from "express";
import { badRequest } from "../../lib/errors.js";
import { ok } from "../../lib/http.js";
import { extractDomain, isValidDomain } from "../../lib/normalize.js";
import { checkSite } from "../../integrations/site.js";

/** GET /public/site-check?domain=acme.com: can this site be read, and if not, why, in plain words. */
export async function siteCheck(req: Request, res: Response) {
  const domain = extractDomain(String(req.query.domain ?? ""));
  if (!domain || !isValidDomain(domain)) throw badRequest("That doesn't look like a domain. Try something like northwind.io");
  return ok(res, await checkSite(domain));
}
