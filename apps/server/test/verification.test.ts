import { beforeEach, describe, expect, it } from "vitest";
import { api, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setMailSender, type MailMessage } from "../src/integrations/mailer.js";

let outbox: MailMessage[] = [];

beforeEach(async () => {
  await resetDb();
  outbox = [];
  setMailSender(async (m) => {
    outbox.push(m);
    return true;
  });
});

const cookieOf = (res: { headers: Record<string, unknown> }, name: string) =>
  ((res.headers["set-cookie"] as string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));

const linkIn = (m: MailMessage) => {
  const url = new URL(/Use this link instead: (\S+)/.exec(m.text)![1]);
  return { path: url.pathname, token: url.searchParams.get("token")! };
};
const numbersIn = (m: MailMessage) => /Numbers: ([\d ]+)/.exec(m.text)![1].trim().split(/\s+/).map(Number);
const codeIn = (m: MailMessage) => /Code: (\d{6})/.exec(m.text)![1];

async function signUp(email = "alex@northwind.io") {
  const res = await api().post("/api/v1/auth/register").send({ name: "Alex Morgan", email, password: "correct-horse-1", domain: "northwind.io" });
  return res;
}

describe("email verification with number match", () => {
  it("leaves sign up unchanged when email isn't configured", async () => {
    setMailSender(null);
    const res = await signUp();
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    const providers = await api().get("/api/v1/auth/providers");
    expect(providers.body.data.passwordReset).toBe(false);
    const forgot = await api().post("/api/v1/auth/password/forgot").send({ email: "alex@northwind.io" });
    expect(forgot.status).toBe(503);
  });

  it("holds the session until the matching number is tapped", async () => {
    const res = await signUp();
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeUndefined();
    const v = res.body.data.verification;
    expect(res.body.data.verificationRequired).toBe(true);
    expect(v.matchNumber).toBeGreaterThanOrEqual(10);
    expect(cookieOf(res, "ap_refresh")).toBeUndefined();
    const claim = cookieOf(res, "ap_claim")!.split(";")[0];

    expect(outbox).toHaveLength(1);
    const mail = outbox[0];
    expect(mail.to).toBe("alex@northwind.io");
    expect(mail.text).not.toContain(String(v.challengeId));
    const numbers = numbersIn(mail);
    expect(numbers).toHaveLength(3);
    expect(numbers).toContain(v.matchNumber);
    const { path, token } = linkIn(mail);
    expect(path).toBe("/verify");

    const status = await api().post("/api/v1/auth/challenge/status").send({ challengeId: v.challengeId });
    expect(status.body.data.status).toBe("PENDING");
    const early = await api().post("/api/v1/auth/claim").set("Cookie", claim).send({});
    expect(early.body.data).toEqual({ claimed: false, reason: "not-verified" });

    const wrong = numbers.find((n) => n !== v.matchNumber)!;
    const miss = await api().post("/api/v1/auth/verify-email").send({ token, n: String(wrong) });
    expect(miss.status).toBe(400);
    expect(miss.body.error.details).toEqual({ reason: "wrong_number", attemptsLeft: 2 });

    const hit = await api().post("/api/v1/auth/verify-email").send({ token, n: String(v.matchNumber) });
    expect(hit.status).toBe(200);
    expect(hit.body.data.accessToken).toBeTruthy();
    expect(cookieOf(hit, "ap_refresh")).toBeTruthy();

    const after = await api().post("/api/v1/auth/challenge/status").send({ challengeId: v.challengeId });
    expect(after.body.data.status).toBe("APPROVED");
    const claimed = await api().post("/api/v1/auth/claim").set("Cookie", claim).send({});
    expect(claimed.body.data.claimed).toBe(true);
    expect(claimed.body.data.session.user.email).toBe("alex@northwind.io");

    const again = await api().post("/api/v1/auth/verify-email").send({ token, n: String(v.matchNumber) });
    expect(again.status).toBe(410);
    expect(again.body.error.details.reason).toBe("already_used");

    const login = await api().post("/api/v1/auth/login").send({ email: "alex@northwind.io", password: "correct-horse-1" });
    expect(login.body.data.accessToken).toBeTruthy();
  });

  it("asks an unverified account to verify at sign in without sending a second email straight away", async () => {
    const first = await signUp();
    const login = await api().post("/api/v1/auth/login").send({ email: "alex@northwind.io", password: "correct-horse-1" });
    expect(login.status).toBe(200);
    expect(login.body.data.verificationRequired).toBe(true);
    expect(login.body.data.verification.challengeId).toBe(first.body.data.verification.challengeId);
    expect(outbox).toHaveLength(1);
    const wrongPassword = await api().post("/api/v1/auth/login").send({ email: "alex@northwind.io", password: "nope-nope-1" });
    expect(wrongPassword.status).toBe(401);
  });

  it("accepts the six-digit code from a second email and signs the waiting screen in", async () => {
    const res = await signUp();
    const { challengeId } = res.body.data.verification;
    const sent = await api().post("/api/v1/auth/challenge/send-code").send({ challengeId });
    expect(sent.body.data).toEqual({ sent: true });
    const again = await api().post("/api/v1/auth/challenge/send-code").send({ challengeId });
    expect(again.status).toBe(429);
    expect(outbox).toHaveLength(2);
    const code = codeIn(outbox[1]);
    const bad = await api().post("/api/v1/auth/challenge/code").send({ challengeId, code: code === "000000" ? "111111" : "000000" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe("wrong_code");
    const good = await api().post("/api/v1/auth/challenge/code").send({ challengeId, code });
    expect(good.status).toBe(200);
    expect(good.body.data.purpose).toBe("VERIFY");
    expect(good.body.data.session.accessToken).toBeTruthy();
    expect(cookieOf(good, "ap_refresh")).toBeTruthy();
  });

  it("locks the number way after three wrong numbers and emails the code instead", async () => {
    const res = await signUp();
    const { token } = linkIn(outbox[0]);
    const wrong = numbersIn(outbox[0]).find((n) => n !== res.body.data.verification.matchNumber)!;
    for (let i = 0; i < 2; i++) await api().post("/api/v1/auth/verify-email").send({ token, n: String(wrong) });
    const last = await api().post("/api/v1/auth/verify-email").send({ token, n: String(wrong) });
    expect(last.status).toBe(410);
    expect(last.body.error.details.reason).toBe("too_many_attempts");

    const claim = cookieOf(res, "ap_claim")!.split(";")[0];
    const resend = await api().post("/api/v1/auth/verify-email/resend").set("Cookie", claim).send({});
    expect(resend.status).toBe(200);
    expect(resend.body.data.matchNumber).toBeNull();
    expect(resend.body.data.codeSent).toBe(true);
    expect(outbox.at(-1)!.subject).toContain("verification code");
  });

  it("only resends from the screen that signed up, and not more than once a minute", async () => {
    const res = await signUp();
    const noClaim = await api().post("/api/v1/auth/verify-email/resend").send({});
    expect(noClaim.status).toBe(401);
    const claim = cookieOf(res, "ap_claim")!.split(";")[0];
    const tooSoon = await api().post("/api/v1/auth/verify-email/resend").set("Cookie", claim).send({});
    expect(tooSoon.status).toBe(429);
    await prisma.emailChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    const resend = await api().post("/api/v1/auth/verify-email/resend").set("Cookie", claim).send({});
    expect(resend.status).toBe(200);
    expect(resend.body.data.challengeId).not.toBe(res.body.data.verification.challengeId);
    const oldToken = linkIn(outbox[0]).token;
    const old = await api().post("/api/v1/auth/verify-email").send({ token: oldToken });
    expect(old.status).toBe(410);
  });

  it("treats an expired email as expired", async () => {
    await signUp();
    await prisma.emailChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api().post("/api/v1/auth/verify-email").send({ token: linkIn(outbox[0]).token });
    expect(res.status).toBe(410);
    expect(res.body.error.details.reason).toBe("expired");
  });
});

describe("password reset with number match", () => {
  async function verifiedUser() {
    setMailSender(null);
    await signUp();
    await prisma.user.updateMany({ data: { emailVerifiedAt: new Date() } });
    setMailSender(async (m) => {
      outbox.push(m);
      return true;
    });
  }

  it("answers the same way for an unknown email and sends nothing", async () => {
    const res = await api().post("/api/v1/auth/password/forgot").send({ email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.data.challengeId).toHaveLength(24);
    expect(res.body.data.matchNumber).toBeGreaterThanOrEqual(10);
    expect(outbox).toHaveLength(0);
    const status = await api().post("/api/v1/auth/challenge/status").send({ challengeId: res.body.data.challengeId });
    expect(status.body.data.status).toBe("PENDING");
  });

  it("changes the password only after the number is tapped, then signs out other sessions", async () => {
    await verifiedUser();
    const oldSession = await api().post("/api/v1/auth/login").send({ email: "alex@northwind.io", password: "correct-horse-1" });
    const oldRefresh = cookieOf(oldSession, "ap_refresh")!.split(";")[0];

    const forgot = await api().post("/api/v1/auth/password/forgot").send({ email: "alex@northwind.io" });
    expect(forgot.status).toBe(200);
    expect(outbox).toHaveLength(1);
    const { path, token } = linkIn(outbox[0]);
    expect(path).toBe("/reset-password");

    const early = await api().post("/api/v1/auth/password/reset").send({ token, password: "brand-new-pass-2" });
    expect(early.status).toBe(410);
    expect(early.body.error.details.reason).toBe("not_answered");

    const check = await api().post("/api/v1/auth/password/check").send({ token, n: String(forgot.body.data.matchNumber) });
    expect(check.body.data).toEqual({ ok: true });
    const reopen = await api().post("/api/v1/auth/password/check").send({ token });
    expect(reopen.body.data).toEqual({ ok: true });

    const done = await api().post("/api/v1/auth/password/reset").send({ token, password: "brand-new-pass-2" });
    expect(done.body.data).toEqual({ updated: true });
    const replay = await api().post("/api/v1/auth/password/reset").send({ token, password: "another-pass-3" });
    expect(replay.status).toBe(410);

    const refresh = await api().post("/api/v1/auth/refresh").set("Cookie", oldRefresh).set("X-Requested-With", "aperture").send({});
    expect(refresh.status).toBe(401);
    const oldLogin = await api().post("/api/v1/auth/login").send({ email: "alex@northwind.io", password: "correct-horse-1" });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api().post("/api/v1/auth/login").send({ email: "alex@northwind.io", password: "brand-new-pass-2" });
    expect(newLogin.body.data.accessToken).toBeTruthy();
  });

  it("hands the waiting screen the reset token when the code is typed there", async () => {
    await verifiedUser();
    const forgot = await api().post("/api/v1/auth/password/forgot").send({ email: "alex@northwind.io" });
    await api().post("/api/v1/auth/challenge/send-code").send({ challengeId: forgot.body.data.challengeId });
    const code = codeIn(outbox[1]);
    const answered = await api().post("/api/v1/auth/challenge/code").send({ challengeId: forgot.body.data.challengeId, code });
    expect(answered.body.data.purpose).toBe("RESET");
    const done = await api().post("/api/v1/auth/password/reset").send({ token: answered.body.data.token, password: "brand-new-pass-2" });
    expect(done.body.data).toEqual({ updated: true });
  });

  it("won't let a verification link be used as a reset or the other way round", async () => {
    await signUp();
    const verifyToken = linkIn(outbox[0]).token;
    const res = await api().post("/api/v1/auth/password/check").send({ token: verifyToken });
    expect(res.status).toBe(410);
  });
});
