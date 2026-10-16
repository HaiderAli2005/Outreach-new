import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://aperture:aperture@localhost:55432/aperture_test?schema=public";
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
  } catch (e) {
    const out = e as { stdout?: Buffer; stderr?: Buffer };
    const detail = `${out.stderr?.toString() ?? ""}${out.stdout?.toString() ?? ""}`.trim();
    throw new Error(`Could not prepare the test database at ${url.replace(/:[^:@/]+@/, ":***@")}. Start it with "npm run db:up" or set TEST_DATABASE_URL.\n${detail}`);
  }
}
