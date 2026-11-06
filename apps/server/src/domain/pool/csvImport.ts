import { MAX_INBOXES_PER_DOMAIN } from "../../config/plans.js";
import { badRequest } from "../../lib/errors.js";
import { parseCsv } from "../../lib/csv.js";
import { prisma } from "../../lib/prisma.js";
import { GOOGLE_IMAP, GOOGLE_SMTP } from "../../integrations/googleMail.js";
import * as manual from "./manual.js";

/**
 * Adds warmed mailboxes from a spreadsheet exported as CSV (Google Sheets: File > Download > CSV).
 *
 * Columns are found by their header, in any order and any case. Only the email and a password are needed:
 *   email | address | mailbox | username          the mailbox address
 *   app password | app_password | password | pass the password (an app password wins when both are filled)
 *   first name / last name, or one name column    the sender name. Missing: taken from the address
 *   smtp host, smtp port, imap host, imap port     only for mailboxes that aren't on Google or Microsoft
 *
 * Rows are grouped by domain. A domain already in the pool only gets the mailboxes it doesn't have yet, so the same
 * file can be uploaded again safely. Passwords go straight to the secret store and are never sent back.
 *
 * auth "google": Google mailboxes with 2-Step Verification on sign in with Google (OAuth), not a password. Google
 * refuses a plain account password over SMTP and IMAP. No password column is needed and any password in the file is
 * ignored. Each mailbox then signs in through the Workspace's service account or its own "Connect with Google".
 */

export type MailboxPlatform = "google" | "microsoft";
export type ImportAuth = "password" | "google";

const SERVERS: Record<MailboxPlatform, { smtpHost: string; smtpPort: number; imapHost: string; imapPort: number }> = {
  google: { smtpHost: GOOGLE_SMTP.host, smtpPort: GOOGLE_SMTP.port, imapHost: GOOGLE_IMAP.host, imapPort: GOOGLE_IMAP.port },
  microsoft: { smtpHost: "smtp.office365.com", smtpPort: 587, imapHost: "outlook.office365.com", imapPort: 993 },
};

export const MAX_IMPORT_ROWS = 600;

const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const COLUMNS = {
  address: ["email", "emailaddress", "address", "mailbox", "mailboxemail", "inbox", "username", "login", "user"],
  appPassword: ["apppassword", "apppass", "appspecificpassword", "smtppassword"],
  password: ["password", "pass", "pwd", "mailboxpassword"],
  firstName: ["firstname", "first", "givenname", "fname"],
  lastName: ["lastname", "last", "surname", "familyname", "lname"],
  name: ["name", "fullname", "sendername", "displayname", "fromname"],
  smtpHost: ["smtphost", "smtpserver", "smtp"],
  smtpPort: ["smtpport"],
  imapHost: ["imaphost", "imapserver", "imap"],
  imapPort: ["imapport"],
} as const;
type Column = keyof typeof COLUMNS;

export interface ImportRow {
  line: number;
  address: string;
  firstName: string;
  lastName: string | null;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface ImportProblem {
  line: number | null;
  address: string | null;
  message: string;
}

export interface ParsedImport {
  columns: Partial<Record<Column, string>>;
  rows: ImportRow[];
  problems: ImportProblem[];
}

const title = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

/** Reads the file. Never throws for a bad row: each one comes back as a problem with its line number. */
export function parseMailboxCsv(text: string, platform: MailboxPlatform, auth: ImportAuth = "password"): ParsedImport {
  if (auth === "google" && platform !== "google") throw badRequest("Google sign-in is only for Google mailboxes");
  const table = parseCsv(text);
  if (!table.length) throw badRequest("The file is empty");
  const header = table[0].map(key);
  const at: Partial<Record<Column, number>> = {};
  const columns: Partial<Record<Column, string>> = {};
  for (const col of Object.keys(COLUMNS) as Column[]) {
    const i = header.findIndex((h) => (COLUMNS[col] as readonly string[]).includes(h));
    if (i >= 0 && !Object.values(at).includes(i)) {
      at[col] = i;
      columns[col] = table[0][i].trim();
    }
  }
  if (at.address === undefined) throw badRequest("No email column found. Name the column with the mailbox addresses \"email\".");
  if (auth === "password" && at.password === undefined && at.appPassword === undefined) throw badRequest("No password column found. Name it \"password\" or \"app password\".");
  if (table.length - 1 > MAX_IMPORT_ROWS) throw badRequest(`Upload at most ${MAX_IMPORT_ROWS} mailboxes at a time`);

  const get = (r: string[], c: Column) => (at[c] === undefined ? "" : (r[at[c]!] ?? "").trim());
  const rows: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Set<string>();
  const defaults = SERVERS[platform];

  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const address = get(r, "address").toLowerCase().replace(/^mailto:/, "");
    if (!address) return problems.push({ line, address: null, message: "No email on this row" }), undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return problems.push({ line, address, message: "Not an email address" }), undefined;
    if (seen.has(address)) return problems.push({ line, address, message: "Listed twice in the file. The first row is used" }), undefined;
    seen.add(address);
    // A Google mailbox sends with its app password, so it wins over the account password when both are given.
    // App passwords are shown in groups of four ("abcd efgh ijkl mnop"); the spaces aren't part of them.
    const password = auth === "google" ? "" : get(r, "appPassword").replace(/\s+/g, "") || get(r, "password");
    if (auth === "password" && !password) return problems.push({ line, address, message: "No password on this row" }), undefined;

    let firstName = get(r, "firstName");
    let lastName = get(r, "lastName") || null;
    if (!firstName && get(r, "name")) {
      const [f, ...rest] = get(r, "name").split(/\s+/);
      firstName = f;
      lastName = lastName ?? (rest.join(" ") || null);
    }
    if (!firstName) firstName = title(address.split("@")[0].split(/[._-]/)[0].replace(/[^a-z]/gi, ""));
    if (firstName.length < 2) return problems.push({ line, address, message: "Add a first name column: the name can't be read from this address" }), undefined;

    const port = (v: string, d: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : d;
    };
    rows.push({
      line,
      address,
      firstName,
      lastName,
      password,
      smtpHost: get(r, "smtpHost") || defaults.smtpHost,
      smtpPort: port(get(r, "smtpPort"), defaults.smtpPort),
      imapHost: get(r, "imapHost") || defaults.imapHost,
      imapPort: port(get(r, "imapPort"), defaults.imapPort),
    });
  });
  if (!rows.length && !problems.length) throw badRequest("The file has a header but no mailboxes");
  return { columns, rows, problems };
}

export interface ImportDomainPlan {
  name: string;
  exists: boolean;
  add: { line: number; address: string; name: string }[];
  skip: { line: number; address: string; message: string }[];
  error: string | null;
}

export interface ImportResult {
  columns: Partial<Record<Column, string>>;
  platform: MailboxPlatform;
  auth: ImportAuth;
  domains: (ImportDomainPlan & { added?: { id?: string; address: string; ok: boolean; error?: string }[] })[];
  problems: ImportProblem[];
  totals: { mailboxes: number; toAdd: number; domains: number; newDomains: number; skipped: number; failed: number; signedIn?: number };
  done: boolean;
}

const domainOf = (address: string) => address.split("@")[1];

async function planDomains(rows: ImportRow[]): Promise<{ plan: ImportDomainPlan; rows: ImportRow[] }[]> {
  const groups = new Map<string, ImportRow[]>();
  for (const r of rows) groups.set(domainOf(r.address), [...(groups.get(domainOf(r.address)) ?? []), r]);
  const names = [...groups.keys()];
  const [domains, taken] = await Promise.all([
    prisma.sendingDomain.findMany({ where: { name: { in: names } }, include: { mailboxes: { where: { status: { not: "RETIRED" } }, select: { address: true } } } }),
    prisma.mailbox.findMany({ where: { address: { in: rows.map((r) => r.address) }, status: { not: "RETIRED" } }, select: { address: true } }),
  ]);
  const inPool = new Set(taken.map((t) => t.address));
  return names.sort().map((name) => {
    const group = groups.get(name)!;
    const d = domains.find((x) => x.name === name);
    const plan: ImportDomainPlan = { name, exists: !!d, add: [], skip: [], error: null };
    const keep: ImportRow[] = [];
    for (const r of group) {
      if (inPool.has(r.address)) plan.skip.push({ line: r.line, address: r.address, message: "Already in the pool" });
      else keep.push(r);
    }
    if (d && d.organizationId) plan.error = `${name} belongs to a customer, not the pool`;
    else if (d && (d.status === "DEGRADED" || d.status === "RETIRED")) plan.error = `${name} is ${d.status.toLowerCase()} and takes no new mailboxes`;
    else if (keep.length + (d?.mailboxes.length ?? 0) > MAX_INBOXES_PER_DOMAIN)
      plan.error = `${name} would hold ${keep.length + (d?.mailboxes.length ?? 0)} mailboxes. A domain holds at most ${MAX_INBOXES_PER_DOMAIN}`;
    if (!plan.error) plan.add = keep.map((r) => ({ line: r.line, address: r.address, name: [r.firstName, r.lastName].filter(Boolean).join(" ") }));
    return { plan, rows: plan.error ? [] : keep };
  });
}

const totalsOf = (domains: ImportResult["domains"], rows: number) => ({
  mailboxes: rows,
  toAdd: domains.reduce((n, d) => n + d.add.length, 0),
  domains: domains.length,
  newDomains: domains.filter((d) => !d.exists && !d.error).length,
  skipped: domains.reduce((n, d) => n + d.skip.length, 0),
  failed: domains.filter((d) => d.error).length,
});

export interface ImportOptions {
  platform: MailboxPlatform;
  /** "google": sign in with Google (OAuth), for mailboxes with 2-Step Verification. Default "password". */
  auth?: ImportAuth;
  region: string;
  locale: string;
  /** false: only read the file and say what would happen. */
  commit: boolean;
}

export async function importMailboxCsv(text: string, opts: ImportOptions, operatorId: string): Promise<ImportResult> {
  const auth = opts.auth ?? "password";
  const parsed = parseMailboxCsv(text, opts.platform, auth);
  const planned = await planDomains(parsed.rows);
  const domains: ImportResult["domains"] = planned.map((p) => ({ ...p.plan }));
  if (!opts.commit) return { columns: parsed.columns, platform: opts.platform, auth, domains, problems: parsed.problems, totals: totalsOf(domains, parsed.rows.length), done: false };

  let signedIn = 0;
  // One domain at a time: each one signs its mailboxes in and checks its DNS, and a failure stays with that domain.
  for (const [i, p] of planned.entries()) {
    const out = domains[i];
    if (!p.rows.length) continue;
    const input = (r: ImportRow) =>
      auth === "google"
        ? { address: r.address, firstName: r.firstName, lastName: r.lastName, auth: "google" as const }
        : { address: r.address, firstName: r.firstName, lastName: r.lastName, auth: "password" as const, username: r.address, password: r.password, smtpHost: r.smtpHost, smtpPort: r.smtpPort, imapHost: r.imapHost, imapPort: r.imapPort };
    try {
      if (!out.exists) {
        const res = await manual.addDomain({ name: out.name, warmed: true, region: opts.region, locale: opts.locale, mailboxes: p.rows.map(input) }, operatorId);
        out.added = res.mailboxes.map((m) => ({ id: m.id, address: m.address, ok: m.ok, error: m.error }));
      } else {
        const d = await prisma.sendingDomain.findFirstOrThrow({ where: { name: out.name, organizationId: null }, select: { id: true } });
        out.added = [];
        for (const r of p.rows) {
          try {
            const m = await manual.addMailbox(d.id, { ...input(r), locale: opts.locale }, operatorId);
            out.added.push({ id: m.id, address: m.address, ok: m.ok, error: m.error });
          } catch (e) {
            out.added.push({ address: r.address, ok: false, error: (e as Error).message });
          }
        }
      }
      signedIn += out.added.filter((m) => m.ok).length;
    } catch (e) {
      out.error = (e as Error).message;
      out.add = [];
    }
  }
  return { columns: parsed.columns, platform: opts.platform, auth, domains, problems: parsed.problems, totals: { ...totalsOf(domains, parsed.rows.length), signedIn }, done: true };
}
