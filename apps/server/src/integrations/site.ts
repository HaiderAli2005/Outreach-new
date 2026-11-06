import { lookup, resolveNs, resolveSoa, resolveMx, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 600_000;

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80")) return false;
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    return true;
  }
  return false;
}

/** Why a page couldn't be read. Kept so the customer is told the real reason, at the moment they enter the domain. */
export type ReadFailureKind = "missing" | "dns" | "private" | "timeout" | "tls" | "connect" | "blocked" | "http" | "not-html" | "empty";
export interface ReadFailure {
  kind: ReadFailureKind;
  status?: number;
  code?: string;
}

class ReadError extends Error {
  constructor(readonly failure: ReadFailure) {
    super(failure.code ?? failure.kind);
  }
}

async function hostAddresses(host: string): Promise<{ ok: true } | { ok: false; failure: ReadFailure }> {
  if (isIP(host)) return isPublicAddress(host) ? { ok: true } : { ok: false, failure: { kind: "private" } };
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return { ok: false, failure: { kind: "missing" } };
    return addrs.every((a) => isPublicAddress(a.address)) ? { ok: true } : { ok: false, failure: { kind: "private" } };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, failure: { kind: code === "ENOTFOUND" || code === "ENODATA" ? "missing" : "dns", code } };
  }
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS|HOSTNAME/i;

/** The network error behind a failed fetch, as one of the reasons above. */
function classify(err: unknown): ReadFailure {
  if (err instanceof ReadError) return err.failure;
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return { kind: "timeout" };
  const code = e?.cause?.code ?? e?.code ?? "";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return { kind: "timeout", code };
  if (TLS_CODES.test(code) || TLS_CODES.test(e?.cause?.message ?? "")) return { kind: "tls", code: code || undefined };
  if (code === "ENOTFOUND") return { kind: "missing", code };
  if (code === "EAI_AGAIN") return { kind: "dns", code };
  return { kind: "connect", code: code || undefined };
}

const BOT_UA = "Mozilla/5.0 (compatible; ApertureBot/1.0)";
/** Some firewalls turn away anything that names itself a bot. The customer asked us to read their own site, so a refused home page is asked for once more as a normal browser would. */
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function safeFetch(start: string, signal: AbortSignal, ua = BOT_UA): Promise<Response> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) throw new ReadError({ kind: "connect" });
    const host = await hostAddresses(u.hostname);
    if (!host.ok) throw new ReadError(host.failure);
    const res = await fetch(url, { signal, redirect: "manual", headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new ReadError({ kind: "http", code: "too many redirects" });
}

interface Page {
  url: string;
  title: string | null;
  description: string | null;
  text: string;
  body: string;
  lang: string | null;
  logos: string[];
}

function metaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (key !== name) continue;
    const content = tag.match(/\bcontent=["']([^"']{1,500})["']/i)?.[1]?.trim();
    if (content) return content;
  }
  return null;
}

function jsonLdText(html: string): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || out.join(" ").length > 800 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && ["name", "description", "slogan", "alternateName"].includes(k) && x.length > 2 && !/^https?:/.test(x)) out.push(x.trim());
      else if (typeof x === "object") walk(x, depth + 1);
    }
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]), 0);
    } catch {
      /* ignore invalid structured data */
    }
  }
  return [...new Set(out)].join(". ").slice(0, 800);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", pound: "£", euro: "€", copy: "(c)" };

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/(?:[\u2012-\u2015\u25b6-\u25be\u2022\u00b7|/\\>»›→-]\s*){2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bodyText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|template|iframe|select|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?noscript[^>]*>/gi, " ");
  const main = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) {
    const t = htmlToText(main);
    if (t.length > 300) return t;
  }
  return htmlToText(cleaned);
}

const CUSTOMER_HEADING = /(trusted by|our (?:clients|customers)|used by|loved by|companies (?:that|who) (?:use|trust)|brands (?:that|who) (?:use|trust)|join(?:ing)? [\w\s,]{0,30}(?:teams|companies|brands))/i;
const GENERIC_ALT = /^(logo|image|icon|img|photo|picture|client|customer|partner|brand|\d+)$/i;

export function logosFrom(html: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(CUSTOMER_HEADING.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.size < 20) {
    const block = html.slice(m.index, m.index + 5000);
    for (const img of block.matchAll(/<img[^>]*\balt=["']([^"']{2,60})["'][^>]*>/gi)) {
      const alt = img[1].replace(/\b(logo|logotype|icon)\b/gi, "").replace(/\s+/g, " ").trim();
      if (alt.length >= 2 && alt.length <= 40 && !GENERIC_ALT.test(alt)) out.add(decodeEntities(alt)!);
      if (out.size >= 20) break;
    }
  }
  return [...out];
}

const BLOCKED = new Set([401, 403, 406, 429, 451, 503]);

async function probePage(url: string, maxChars: number, timeoutMs: number, ua = BOT_UA): Promise<{ page: Page | null; failure: ReadFailure | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, controller.signal, ua);
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return { page: null, failure: { kind: BLOCKED.has(res.status) ? "blocked" : "http", status: res.status } };
    }
    if (!(res.headers.get("content-type") ?? "").includes("html")) {
      void res.body?.cancel().catch(() => undefined);
      return { page: null, failure: { kind: "not-html" } };
    }
    const html = (await res.text()).slice(0, MAX_BYTES);
    const title = decodeEntities(html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() ?? null);
    const metaDescription = decodeEntities(metaContent(html, "description") ?? metaContent(html, "og:description") ?? metaContent(html, "twitter:description"));
    const description = metaDescription && metaDescription.split(/\s+/).length >= 4 ? metaDescription : null;
    const structured = jsonLdText(html);
    const body = bodyText(html);
    const text = [description, structured, body].filter(Boolean).join(" . ").slice(0, maxChars);
    const lang = html.match(/<html[^>]*\blang=["']?([a-zA-Z]{2})/i)?.[1]?.toLowerCase() ?? null;
    return { page: { url: res.url || url, title, description, text, body, lang, logos: logosFrom(html) }, failure: null };
  } catch (err) {
    return { page: null, failure: classify(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function readPage(url: string, maxChars: number, timeoutMs: number, ua = BOT_UA): Promise<Page | null> {
  return (await probePage(url, maxChars, timeoutMs, ua)).page;
}

/** Which failure says most about the site. A refusal or an error page beats "couldn't connect", which beats "no such host". */
const RANK: Record<ReadFailureKind, number> = { blocked: 9, http: 8, "not-html": 7, empty: 7, tls: 6, timeout: 5, connect: 4, private: 3, dns: 2, missing: 1 };

/** The home page, tried the way a visitor would type the address, with the reason when none of them could be read. */
async function readHome(domain: string, perPage: number): Promise<{ home: Page | null; ua: string; failure: ReadFailure | null }> {
  let worst: ReadFailure | null = null;
  for (const origin of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    let r = await probePage(origin, perPage, 10_000);
    let ua = BOT_UA;
    if (r.failure?.kind === "blocked") {
      r = await probePage(origin, perPage, 10_000, BROWSER_UA);
      ua = BROWSER_UA;
    }
    if (r.page) return r.page.text ? { home: r.page, ua, failure: null } : { home: r.page, ua, failure: { kind: "empty" } };
    if (r.failure && (!worst || RANK[r.failure.kind] > RANK[worst.kind])) worst = r.failure;
  }
  return { home: null, ua: BOT_UA, failure: worst ?? { kind: "connect" } };
}

/** What the customer reads when their site can't be opened. Plain words, no codes. */
export function siteFailureMessage(domain: string, f: ReadFailure): string {
  switch (f.kind) {
    case "missing":
      return `We can't find ${domain}. Check the spelling and try again.`;
    case "dns":
      return `We couldn't look up ${domain} right now. Check the address, or try again in a minute.`;
    case "private":
      return `${domain} points to a private network address, so it can't be opened from the internet.`;
    case "timeout":
      return `${domain} took too long to respond.`;
    case "tls":
      return `${domain} has a security certificate problem, so we couldn't open it safely.`;
    case "connect":
      return `We couldn't connect to ${domain}. The site may be offline.`;
    case "blocked":
      return `${domain} blocks automated visits${f.status ? ` (it answered ${f.status})` : ""}.`;
    case "http":
      return `${domain} returned an error${f.status ? ` (${f.status})` : ""} instead of its home page.`;
    case "not-html":
    case "empty":
      return `${domain} has no text we can read on its home page. It may be under construction, or built so its words only appear in a browser.`;
  }
}

export interface SiteCheck {
  domain: string;
  /** ok: the site can be read. missing: no such domain. unreadable: the domain exists but its site can't be read. */
  status: "ok" | "missing" | "unreadable";
  reason: ReadFailureKind | null;
  message: string | null;
  title: string | null;
}

async function checkSiteLive(domain: string): Promise<SiteCheck> {
  const r = await readHome(domain, 1000);
  if (r.home && !r.failure) return { domain, status: "ok", reason: null, message: null, title: r.home.title };
  const f = r.failure!;
  return { domain, status: f.kind === "missing" ? "missing" : "unreadable", reason: f.kind, message: siteFailureMessage(domain, f), title: r.home?.title ?? null };
}

type SiteChecker = (domain: string) => Promise<SiteCheck>;
let siteChecker: SiteChecker = checkSiteLive;

/** Reads the home page the same way the analysis does, so what the customer is told at step 1 matches what step 3 finds. */
export function checkSite(domain: string): Promise<SiteCheck> {
  return siteChecker(domain);
}

export function setSiteChecker(c: SiteChecker | null): void {
  siteChecker = c ?? checkSiteLive;
}

export async function fetchSiteText(domain: string, maxChars = 6000): Promise<{ title: string | null; description: string | null; text: string }> {
  for (const url of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    const page = await readPage(url, maxChars, 10_000);
    if (page) return { title: page.title, description: page.description, text: page.text };
  }
  return { title: null, description: null, text: "" };
}

/** A home page's own language tag and a sample of its words, for working out what language to write to them in. */
export interface LanguageSample {
  lang: string | null;
  text: string;
}
type LanguageReader = (domain: string) => Promise<LanguageSample | null>;
const readLanguageLive: LanguageReader = async (domain) => {
  for (const url of [`https://${domain}`, `https://www.${domain}`]) {
    const page = await readPage(url, 4000, 6_000);
    if (page) return { lang: page.lang, text: page.text };
  }
  return null;
};
let languageReader: LanguageReader = readLanguageLive;

export function readSiteLanguage(domain: string): Promise<LanguageSample | null> {
  return languageReader(domain).catch(() => null);
}

export function setSiteLanguageReader(r: LanguageReader | null): void {
  languageReader = r ?? readLanguageLive;
}

const SUBPAGES = ["/about", "/services", "/products", "/solutions", "/pricing", "/industries", "/customers", "/case-studies", "/testimonials", "/contact"];

export interface SitePage {
  path: string;
  title: string | null;
  text: string;
  logos?: string[];
}

export interface SiteHome {
  title: string | null;
  description: string | null;
  lang?: string | null;
}

const USEFUL_PATH = /about|compan|pricing|price|plans|product|platform|feature|solution|service|industr|customer|client|case|stor(y|ies)|use-?case|who-we|what-we|testimonial|partner/i;
const SKIP_PATH = /terms|privacy|cookie|legal|polic|gdpr|login|log-in|signin|sign-in|signup|sign-up|register|careers?|jobs|press|blog\/|news\//i;

async function sitemapPaths(base: string, host: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await safeFetch(`${base}/sitemap.xml`, controller.signal);
    if (!res || !res.ok) return [];
    const xml = (await res.text()).slice(0, 300_000);
    const paths = new Set<string>();
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      try {
        const u = new URL(m[1]);
        if (u.hostname.replace(/^www\./, "") !== host || u.pathname === "/" || /\.(xml|pdf|jpg|png)$/i.test(u.pathname)) continue;
        if (USEFUL_PATH.test(u.pathname) && !SKIP_PATH.test(u.pathname) && u.pathname.split("/").filter(Boolean).length <= 2) paths.add(u.pathname.replace(/\/$/, ""));
      } catch {
        /* skip bad urls */
      }
    }
    return [...paths].sort((a, b) => a.length - b.length).slice(0, 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Progress callbacks. They only report; they never change what is fetched. */
export interface SiteHooks {
  /** A page request finished (kept or not). */
  onRead?: (path: string) => void;
  /** A page was kept for the analysis. */
  onPage?: (page: SitePage) => void;
}

async function readSitePages(domain: string, hooks: SiteHooks = {}, perPage = 4000, maxPages = 10): Promise<{ home: SiteHome | null; pages: SitePage[]; failure?: ReadFailure | null }> {
  const first = await readHome(domain, perPage);
  const home = first.home;
  if (!home) return { home: null, pages: [], failure: first.failure };
  const base = new URL(home.url).origin;
  const ua = first.ua;
  const host = new URL(base).hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const fingerprint = (body: string) => body.slice(0, 500);
  const pages: SitePage[] = [];
  hooks.onRead?.("/");
  if (home.text) {
    pages.push({ path: "/", title: home.title, text: home.text, logos: home.logos });
    hooks.onPage?.(pages[0]);
    seen.add(fingerprint(home.body));
  }
  const fromSitemap = await sitemapPaths(base, host);
  const candidates = [...new Set([...SUBPAGES, ...fromSitemap])];
  const extra = await Promise.all(
    candidates.map((path) =>
      readPage(`${base}${path}`, perPage, 6_000, ua).then((r) => {
        hooks.onRead?.(path);
        if (!r || r.body.length < 200) return null;
        const landed = new URL(r.url).pathname.replace(/\/$/, "") || "/";
        if (landed === "/") return null;
        return { path: landed, title: r.title, text: r.text, body: r.body, logos: r.logos };
      }),
    ),
  );
  for (const p of extra) {
    if (!p || pages.length >= maxPages || pages.some((x) => x.path === p.path)) continue;
    const key = fingerprint(p.body);
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push({ path: p.path, title: p.title, text: p.text, logos: p.logos });
    hooks.onPage?.(pages[pages.length - 1]);
  }
  return { home: { title: home.title, description: home.description, lang: home.lang }, pages, failure: pages.length ? null : (first.failure ?? { kind: "empty" }) };
}

function decodeEntities(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}

export interface MailSetup {
  hasMx: boolean;
  hasSpf: boolean;
}

export async function mailSetup(domain: string): Promise<MailSetup> {
  const [mx, txt] = await Promise.all([resolveMx(domain).catch(() => []), resolveTxt(domain).catch(() => [])]);
  return { hasMx: mx.length > 0, hasSpf: txt.some((r) => r.join("").toLowerCase().startsWith("v=spf1")) };
}

export async function isRegistered(domain: string): Promise<boolean | null> {
  try {
    const ns = await resolveNs(domain);
    return ns.length > 0;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return false;
    if (code === "ENODATA") {
      try {
        await resolveSoa(domain);
        return true;
      } catch {
        return false;
      }
    }
    return null;
  }
}

type SiteReader = (domain: string, hooks?: SiteHooks) => ReturnType<typeof readSitePages>;
let siteReader: SiteReader = (d, h) => readSitePages(d, h);

export function fetchSitePages(domain: string, hooks?: SiteHooks) {
  return siteReader(domain, hooks);
}

export function setSiteReader(r: SiteReader | null): void {
  siteReader = r ?? ((d, h) => readSitePages(d, h));
}

/**
 * The email addresses a business publishes on its own site: the home page and the usual contact pages, on its own
 * domain only (never a gmail address or someone else's). Used for Google Maps businesses with no named person.
 */
type EmailReader = (domain: string) => Promise<string[]>;
const CONTACT_PATHS = ["", "/contact", "/contact-us", "/contactus", "/en/contact", "/ar/contact", "/about"];
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const readEmailsLive: EmailReader = async (domain) => {
  const found = new Set<string>();
  const mine = (e: string) => {
    const host = e.split("@")[1] ?? "";
    return host === domain || host.endsWith(`.${domain}`);
  };
  for (const path of CONTACT_PATHS) {
    const page = (await readPage(`https://${domain}${path}`, 20_000, 8_000)) ?? (path ? null : await readPage(`https://www.${domain}`, 20_000, 8_000));
    if (!page) continue;
    for (const raw of `${page.body} ${page.text}`.match(EMAIL_RE) ?? []) {
      const e = raw.toLowerCase().replace(/^mailto:/, "");
      if (mine(e) && !/\.(png|jpe?g|gif|webp|svg)$/.test(e)) found.add(e);
    }
    if (found.size >= 3) break;
  }
  return [...found];
};
let emailReader: EmailReader = readEmailsLive;

export function readSiteEmails(domain: string): Promise<string[]> {
  return emailReader(domain);
}

export function setSiteEmailReader(r: EmailReader | null): void {
  emailReader = r ?? readEmailsLive;
}
