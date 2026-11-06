import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** A value from apps/server/.env, read locally so the dev runner can start the Stripe listener. Never printed. */
function serverEnv(name) {
  const file = "apps/server/.env";
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return (line?.slice(name.length + 1) ?? "").trim().replace(/^["']|["']$/g, "");
}

if (process.env.APERTURE_NO_DOCKER !== "1") {
  const compose = "docker compose -f infra/docker-compose.yml";
  try {
    console.log("Starting the database and Redis in Docker...");
    execSync(`${compose} up -d postgres redis`, { stdio: "inherit" });
  } catch {
    console.error("\nDocker Desktop isn't running. Open Docker Desktop, wait until it says Engine running, then run npm run dev again.");
    process.exit(1);
  }
  for (let i = 0; ; i++) {
    try {
      execSync(`${compose} exec -T postgres pg_isready -U aperture -d aperture`, { stdio: "ignore" });
      break;
    } catch {
      if (i >= 30) {
        console.error("\nThe database container started but isn't answering. Check it in Docker Desktop, then run npm run dev again.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

try {
  console.log("Applying any new database migrations (existing data is kept) and updating the database client...");
  execSync("npm run prisma:deploy -w apps/server", { stdio: "inherit" });
} catch {
  console.error("\nCould not update the database. Check Docker Desktop is running and apps/server/.env exists (npm run setup creates it), then try again.");
  process.exit(1);
}
try {
  execSync("npm exec -w apps/server -- prisma generate", { stdio: "inherit" });
} catch {
  console.error("\nCould not update the database client. Close every other terminal running Aperture (the API keeps the client open), then run npm run dev again.");
  process.exit(1);
}

// Stripe can't reach localhost, so payments made here only reach the webhook (and Admin → Webhooks) through the
// Stripe CLI. When it is installed and a test key is set, start it and hand its signing secret to the API.
const STRIPE_EVENTS = "setup_intent.succeeded,setup_intent.setup_failed,payment_intent.succeeded,payment_intent.payment_failed,payment_intent.processing,payment_intent.requires_action,charge.refunded,charge.dispute.created,charge.dispute.closed";
const stripeKey = serverEnv("STRIPE_SECRET_KEY");
const stripeEnv = { ...process.env, STRIPE_API_KEY: stripeKey };
let webhookSecret = "";
if (stripeKey && process.env.APERTURE_NO_STRIPE_LISTEN !== "1") {
  try {
    execSync("stripe --version", { stdio: "ignore" });
    webhookSecret = execSync("stripe listen --print-secret", { env: stripeEnv }).toString().trim();
  } catch {
    console.log(
      "\nStripe CLI not found, so Stripe events can't reach this computer and Admin → Webhooks stays empty. Paid top-ups are still credited (the app checks each payment with Stripe).\nTo get webhooks locally, install the Stripe CLI (https://docs.stripe.com/stripe-cli), run stripe login once, then npm run dev again.\n",
    );
  }
}

const WIN = process.platform === "win32";

/** Stops a process and everything it started. On Windows `kill` only ends the shell wrapper, leaving node running. */
function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (WIN) {
    try {
      execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  } else p.kill();
}

/**
 * A node process left over from an earlier run (the terminal closed, the API crashed) can still hold a port, so the
 * new run can't start and the page talks to nothing. Frees ports 3100 and 4000, stopping only node processes.
 */
function freePorts(ports) {
  if (!WIN) return;
  let lines = [];
  try {
    lines = execSync("netstat -ano -p tcp", { encoding: "utf8" }).split(/\r?\n/);
  } catch {
    return;
  }
  const pids = new Set();
  for (const l of lines) {
    const m = l.trim().split(/\s+/);
    if (m.length >= 5 && m[3] === "LISTENING" && ports.some((p) => m[1].endsWith(`:${p}`))) pids.add(m[4]);
  }
  for (const pid of pids) {
    let image = "";
    try {
      image = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
    } catch {
      continue;
    }
    if (!/^"node\.exe"/i.test(image.trim())) continue;
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      console.log(`Stopped an old Aperture process (pid ${pid}) that was still holding a port from an earlier run.`);
    } catch {
      // Gone already.
    }
  }
}
freePorts([3100, 4000]);

const names = webhookSecret ? ["server", "client", "stripe"] : ["server", "client"];
const procs = new Map();
let stopping = false;
/** API restarts in the last 10 minutes: past 5, something is really broken, so stop instead of looping. */
const restarts = [];

function stopAll(code) {
  stopping = true;
  for (const p of procs.values()) killTree(p);
  process.exit(code ?? 0);
}

function start(name) {
  const p =
    name === "stripe"
      ? spawn("stripe", ["listen", "--forward-to", "localhost:4000/api/v1/billing/webhook", "--events", STRIPE_EVENTS], { stdio: ["ignore", "pipe", "pipe"], shell: true, env: stripeEnv })
      : spawn("npm", ["run", `dev:${name}`], { stdio: ["ignore", "pipe", "pipe"], shell: true, env: name === "server" && webhookSecret ? { ...process.env, STRIPE_WEBHOOK_SECRET: webhookSecret } : process.env });
  const tag = name === "server" ? "\x1b[33m[server]\x1b[0m " : name === "stripe" ? "\x1b[35m[stripe]\x1b[0m " : "\x1b[36m[client]\x1b[0m ";
  const pipe = (s, out) => s.on("data", (d) => out.write(d.toString().replace(/^(?=.)/gm, tag)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    if (stopping) return;
    console.log(`${tag}exited with code ${code}`);
    // The Stripe listener stopping only stops webhooks; the app keeps running.
    if (name === "stripe") return;
    if (name === "server") {
      const now = Date.now();
      while (restarts.length && now - restarts[0] > 10 * 60_000) restarts.shift();
      if (restarts.length < 5) {
        restarts.push(now);
        console.log(`${tag}restarting the API in 2 seconds, so the web app never runs without it.`);
        killTree(p);
        setTimeout(() => !stopping && start("server"), 2000);
        return;
      }
      console.error(`${tag}the API stopped 5 times in 10 minutes. Stopping everything; read the error above, fix it, then run npm run dev again.`);
    }
    stopAll(code);
  });
  procs.set(name, p);
  return p;
}
names.forEach(start);

console.log("Starting the API on http://localhost:4000 and the web app on http://localhost:3100. Press Ctrl+C to stop.");
if (webhookSecret) console.log("Stripe events are forwarded to the API, so payments show in Admin → Webhooks.");
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
