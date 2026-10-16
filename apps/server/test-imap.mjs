import { ImapFlow } from "imapflow";

// Put your mailbox and app password here, then run:  node test-imap.mjs
const USER = "karim@tryrankhouse.com";
const PASS = "PUT_YOUR_16_CHARACTER_APP_PASSWORD_HERE";

const client = new ImapFlow({
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  auth: { user: USER, pass: PASS },
  logger: true,
  connectionTimeout: 20000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
});

const started = Date.now();
try {
  await client.connect();
  console.log(`\n==== CONNECTED in ${Date.now() - started}ms ====`);
  const lock = await client.getMailboxLock("INBOX");
  console.log("INBOX opened. messages:", client.mailbox.exists);
  lock.release();
  await client.logout();
  console.log("==== ALL OK ====");
} catch (e) {
  console.error(`\n==== FAILED after ${Date.now() - started}ms ====`);
  console.error("name   :", e.name);
  console.error("message:", e.message);
  console.error("code   :", e.code);
  console.error("\nfull error:");
  console.error(e);
  process.exit(1);
}
