import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  WEB_ORIGIN: z.string().default("http://localhost:3100"),
  PUBLIC_API_URL: z.string().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: optional,
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (base64, 32 bytes)"),
  JOBS_SECRET: z.string().min(8),
  WEBHOOK_SECRET: z.string().min(8),
  APPROVE_LINK_SECRET: z.string().min(8),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: optional,
  STRIPE_SECRET_KEY: optional,
  STRIPE_PUBLISHABLE_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  MAIL_HOST: optional,
  MAIL_PORT: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.coerce.number().int().positive().default(587)),
  MAIL_USER: optional,
  MAIL_PASS: optional,
  MAIL_FROM: optional,
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  /**
   * Models for the first impression (the business analysis and the sample emails), best first, separated by commas.
   * A model the account can't use is skipped; OPENAI_MODEL is the last resort.
   */
  OPENAI_ANALYSIS_MODEL: z.string().default("gpt-6-luna,gpt-4.1"),
  APOLLO_API_KEY: optional,
  MILLIONVERIFIER_API_KEY: optional,
  SLACK_WEBHOOK_URL: optional,
  /** Email finders after Apollo, in order. Each must be confirmed to allow resale inside a SaaS before it is listed. */
  FINDER_WATERFALL: z.string().default(""),
  ANYMAILFINDER_API_KEY: optional,
  /**
   * Run every background job inside the API on its own schedule (registry.ts), for a machine with no Cloud
   * Scheduler. On by default in development, off elsewhere.
   */
  RUN_JOBS_IN_PROCESS: z.string().optional(),
  /**
   * Instant replies: hold an IMAP IDLE connection per sending mailbox inside the API (domain/sending/watch.ts). On by
   * default in development. In production run it as its own always-on process (`npm run watcher`) and leave it off here.
   */
  MAILBOX_WATCH: z.string().optional(),
  /** The most mailboxes one watcher process holds open. The rest are still read by the 2-minute poll. */
  MAILBOX_WATCH_MAX: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), z.coerce.number().int().positive().default(300)),
  /** Split the pool across watcher processes: "i/n" takes the mailboxes whose id hashes to i of n. Default one process. */
  MAILBOX_WATCH_SHARD: z.preprocess(
    (v) => (typeof v === "string" && !v.trim() ? undefined : v),
    z
      .string()
      .regex(/^\d+\/[1-9]\d*$/, 'MAILBOX_WATCH_SHARD is "index/count", for example 0/2')
      .optional(),
  ),
  /**
   * Where mailbox passwords live. Never in Postgres. "gcp" uses Google Secret Manager (GCP_PROJECT_ID, the service
   * account of the API); "file" keeps them encrypted with ENCRYPTION_KEY in SECRETS_FILE, for local development.
   */
  SECRET_STORE: z.enum(["file", "gcp", "memory"]).optional(),
  SECRETS_FILE: z.string().default(".secrets/mailboxes.json"),
  GCP_PROJECT_ID: optional,
  /** A mailbox we control on another provider (for example Gmail). One message a day per domain goes there and
   *  is read back to confirm SPF, DKIM and DMARC pass. Its password is stored in the secret store as "seed". */
  SEED_MAILBOX_ADDRESS: optional,
  SEED_IMAP_HOST: z.string().default("imap.gmail.com"),
  SEED_IMAP_PORT: z.coerce.number().int().positive().default(993),
  /** Share of the pool's daily capacity kept for paying customers before internal outreach may use it. */
  POOL_CUSTOMER_RESERVE: z.coerce.number().min(0).max(1).default(0.2),
  ANALYSIS_STREAM: z.string().optional(),
  ACCURATE_COMPANY_COUNT: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Keys the product can't run without: address verification and payments. Mail is sent by us, over SMTP. */
export const REQUIRED_KEYS = ["MILLIONVERIFIER_API_KEY", "STRIPE_SECRET_KEY"] as const;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const env = parsed.data;
  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length) {
    const msg = `These API keys are empty, and nothing that uses them will work until they are set: ${missing.join(", ")}`;
    // Production refuses to start, naming every missing key at once rather than failing at the first API call.
    if (env.NODE_ENV === "production") throw new Error(msg);
    if (env.NODE_ENV === "development") console.warn(`\n[aperture] ${msg}\n`);
  }
  if (env.NODE_ENV === "production" && (env.SECRET_STORE ?? "file") !== "gcp") {
    // A local file does not survive a Cloud Run instance, and mailbox passwords must not end up in the database.
    console.warn("[aperture] SECRET_STORE is not 'gcp' in production; mailbox passwords are kept in a local file.");
  }
  if (env.NODE_ENV === "production") {
    for (const key of ["JOBS_SECRET", "WEBHOOK_SECRET", "APPROVE_LINK_SECRET"] as const) {
      if (env[key].startsWith("change-me")) throw new Error(`${key} still has its placeholder value`);
    }
  }
  return env;
}

export const env = load();

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

export const webOrigins = env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Where Google sends people back. By default it is the web app's own /api path (proxied to the API), so the
 * sign-in cookies are set on the same site the app runs on, locally and in production.
 */
export const googleRedirectUri = env.GOOGLE_REDIRECT_URI || `${(webOrigins[0] ?? "").replace(/\/$/, "")}/api/v1/auth/oauth/google/callback`;

export const features = {
  googleOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  ai: Boolean(env.OPENAI_API_KEY),
  mail: Boolean(env.MAIL_HOST && env.MAIL_USER && env.MAIL_PASS && env.MAIL_FROM),
  /** Live progress stream for the business analysis. Off means the old single request. */
  analysisStream: !/^(0|false|no|off)$/i.test(env.ANALYSIS_STREAM ?? "true"),
  /** One paid organisation-level count per audience, for a true company total. */
  accurateCompanyCount: /^(1|true|yes|on)$/i.test(env.ACCURATE_COMPANY_COUNT ?? "false"),
  /** Every background job runs inside the API on its schedule: on by default in development, where no scheduler runs. */
  jobsInProcess: /^(1|true|yes|on)$/i.test(env.RUN_JOBS_IN_PROCESS ?? (env.NODE_ENV === "development" ? "true" : "false")),
  /** The IDLE mailbox watcher runs inside the API: on by default in development, where no separate watcher runs. */
  mailboxWatchInProcess: /^(1|true|yes|on)$/i.test(env.MAILBOX_WATCH ?? (env.NODE_ENV === "development" ? "true" : "false")),
};
