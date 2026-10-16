import type { Request, Response } from "express";
import { z } from "zod";
import { created, currentUser, ok } from "../../lib/http.js";
import { parseBody } from "../../middleware/validate.js";
import * as manual from "../../domain/pool/manual.js";
import { PERSONA_SEED } from "../../domain/pool/personaSeed.js";

const host = z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "A server name, for example smtp.gmail.com");
const port = z.coerce.number().int().min(1).max(65535);
const locale = z.enum(Object.keys(PERSONA_SEED) as [string, ...string[]]);

const mailbox = z.object({
  address: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(2).max(60),
  lastName: z.string().trim().max(60).nullish(),
  username: z.string().trim().max(254).nullish(),
  password: z.string().min(1).max(500),
  smtpHost: host,
  smtpPort: port,
  imapHost: host,
  imapPort: port,
});

export async function list(_req: Request, res: Response) {
  return ok(res, await manual.listDomains());
}

export async function add(req: Request, res: Response) {
  const body = parseBody(
    req,
    z.object({
      name: z.string().trim().min(3).max(253),
      warmed: z.boolean(),
      region: z.string().trim().min(2).max(10).default("global"),
      locale: locale.default("en"),
      registrar: z.string().trim().max(60).nullish(),
      dkimSelector: z.string().trim().max(63).regex(/^[a-z0-9._-]*$/i).nullish(),
      mailboxes: z.array(mailbox).min(1).max(3),
    }),
  );
  return created(res, await manual.addDomain(body, currentUser(req).id));
}

export async function addMailbox(req: Request, res: Response) {
  const body = parseBody(req, mailbox.extend({ locale: locale.default("en") }));
  return created(res, await manual.addMailbox(String(req.params.id), body, currentUser(req).id));
}

export async function checkDns(req: Request, res: Response) {
  return ok(res, await manual.checkDomainNow(String(req.params.id)));
}

export async function pause(req: Request, res: Response) {
  const body = parseBody(req, z.object({ reason: z.string().trim().min(3, "Say why").max(300) }));
  await manual.pauseDomain(String(req.params.id), body.reason, currentUser(req).id);
  return ok(res, { paused: true });
}

export async function retireDomain(req: Request, res: Response) {
  await manual.retireDomain(String(req.params.id), currentUser(req).id);
  return ok(res, { retired: true });
}

export async function testMailbox(req: Request, res: Response) {
  const body = parseBody(req, z.object({ username: z.string().trim().max(254).nullish(), password: z.string().min(1).max(500).optional() }));
  return ok(res, await manual.testMailbox(String(req.params.id), body.password ? { username: body.username, password: body.password } : undefined));
}

export async function repliesOnly(req: Request, res: Response) {
  await manual.mailboxRepliesOnly(String(req.params.id), currentUser(req).id);
  return ok(res, { repliesOnly: true });
}

export async function retireMailbox(req: Request, res: Response) {
  await manual.retireMailboxNow(String(req.params.id), currentUser(req).id);
  return ok(res, { retired: true });
}
