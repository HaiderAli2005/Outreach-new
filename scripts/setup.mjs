import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const run = (cmd, env = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
};
const secret = (n) => randomBytes(n).toString("base64").replace(/[+/=]/g, "").slice(0, n);

run("docker compose -f infra/docker-compose.yml up -d");
for (let i = 0; ; i++) {
  try {
    execSync("docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U aperture -d aperture", { stdio: "ignore" });
    break;
  } catch {
    if (i >= 30) throw new Error("Postgres did not become ready. Check Docker Desktop is running.");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
run("npm install");

const apiEnv = "apps/server/.env";
let admin = null;
if (!existsSync(apiEnv)) {
  const text = readFileSync("apps/server/.env.example", "utf8")
    .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET=${secret(48)}`)
    .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`)
    .replace(/^JOBS_SECRET=.*$/m, `JOBS_SECRET=${secret(32)}`)
    .replace(/^WEBHOOK_SECRET=.*$/m, `WEBHOOK_SECRET=${secret(32)}`)
    .replace(/^APPROVE_LINK_SECRET=.*$/m, `APPROVE_LINK_SECRET=${secret(32)}`);
  writeFileSync(apiEnv, text);
  admin = { email: "admin@aperture.local", password: secret(20) };
  console.log(`\ncreated ${apiEnv} with fresh local secrets`);
}
if (!existsSync("apps/client/.env.local")) {
  writeFileSync("apps/client/.env.local", readFileSync("apps/client/.env.example", "utf8"));
  console.log("created apps/client/.env.local");
}

run("npm run prisma:deploy -w apps/server");
run("npm run db:seed -w apps/server", admin ? { ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password } : {});

console.log("\nSetup finished. Start the app with: npm run dev");
if (admin) console.log(`Platform admin for /admin: ${admin.email} / ${admin.password}  (shown once, save it)`);
