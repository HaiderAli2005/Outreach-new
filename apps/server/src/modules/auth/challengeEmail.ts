import type { MailMessage } from "../../integrations/mailer.js";

const BRAND = {
  name: "Aperture",
  ink: "#1a1712",
  muted: "#77705f",
  line: "#e8e1d2",
  paper: "#ffffff",
  ground: "#f8f5ee",
  gold: "#c9a45c",
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function numberButton(url: string, value: number) {
  return `
    <td align="center" style="padding:0 7px;">
      <a href="${esc(url)}"
         style="display:block;width:84px;height:84px;line-height:84px;border-radius:50%;text-align:center;
                border:2px solid ${BRAND.ink};background:${BRAND.paper};color:${BRAND.ink};
                font-family:${FONT};font-size:32px;font-weight:700;text-decoration:none;">${esc(value)}</a>
    </td>`;
}

function frame(title: string, preheader: string, body: string, footer: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.ground};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.ground};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:520px;background:${BRAND.paper};border:1px solid ${BRAND.line};border-top:4px solid ${BRAND.gold};border-radius:16px;">
          ${body}
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:16px 24px;font-family:${FONT};">
              <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">${esc(footer)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function heading(title: string, intro: string) {
  return `
          <tr>
            <td style="padding:28px 24px 8px 24px;font-family:${FONT};">
              <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.muted};">${BRAND.name}</div>
              <h1 style="margin:10px 0 0 0;font-size:22px;line-height:1.3;color:${BRAND.ink};font-weight:700;">${esc(title)}</h1>
              <p style="margin:12px 0 0 0;font-size:15px;line-height:1.55;color:${BRAND.muted};">${esc(intro)}</p>
            </td>
          </tr>`;
}

interface NumberMail {
  title: string;
  intro: string;
  instruction: string;
  numbers: number[];
  linkFor: (n: number) => string;
  fallbackUrl: string;
  fallbackLabel: string;
  expiryNote: string;
  subject: string;
}

function numberMail(m: NumberMail, to: string): MailMessage {
  const cells = m.numbers.map((n) => numberButton(m.linkFor(n), n)).join("");
  const body = `${heading(m.title, m.intro)}
          <tr>
            <td style="padding:20px 16px 4px 16px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px 0 24px;font-family:${FONT};">
              <p style="margin:0;font-size:14px;line-height:1.55;color:${BRAND.muted};text-align:center;">${esc(m.instruction)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px 26px 24px;font-family:${FONT};">
              <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${esc(m.expiryNote)}</p>
              <p style="margin:14px 0 0 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">
                Don't have that screen any more?
                <a href="${esc(m.fallbackUrl)}" style="color:${BRAND.ink};text-decoration:underline;">${esc(m.fallbackLabel)}</a>
              </p>
            </td>
          </tr>`;
  const text = [
    m.title,
    "",
    m.intro,
    "",
    `Numbers: ${m.numbers.join("   ")}`,
    `Open the HTML version and ${m.instruction.charAt(0).toLowerCase()}${m.instruction.slice(1)}`,
    "",
    m.expiryNote,
    "",
    `No longer have that screen? Use this link instead: ${m.fallbackUrl}`,
  ].join("\n");
  return {
    to,
    subject: m.subject,
    html: frame(m.title, m.intro, body, "If you didn't ask for this, you can ignore this email. Nothing changes until one of the numbers above is tapped."),
    text,
  };
}

const base = (origin: string) => origin.replace(/\/+$/, "");

export function verifyEmail(to: string, p: { origin: string; token: string; numbers: number[] }): MailMessage {
  const root = base(p.origin);
  return numberMail(
    {
      title: "Confirm your email",
      intro: "Your Aperture screen is showing a number. Tap it here.",
      instruction: "Tap the number shown on the screen where you signed up. That screen carries on by itself.",
      numbers: p.numbers,
      linkFor: (n) => `${root}/verify?token=${encodeURIComponent(p.token)}&n=${n}`,
      fallbackUrl: `${root}/verify?token=${encodeURIComponent(p.token)}`,
      fallbackLabel: "Verify on this device instead",
      expiryNote: "These numbers work for 24 hours, once.",
      subject: "Confirm your email · Aperture",
    },
    to,
  );
}

export function resetEmail(to: string, p: { origin: string; token: string; numbers: number[] }): MailMessage {
  const root = base(p.origin);
  return numberMail(
    {
      title: "Reset your password",
      intro: "The screen that asked for the reset is showing a number. Tap it here.",
      instruction: "Tap the number shown on the screen that asked. You then choose the new password.",
      numbers: p.numbers,
      linkFor: (n) => `${root}/reset-password?token=${encodeURIComponent(p.token)}&n=${n}`,
      fallbackUrl: `${root}/reset-password?token=${encodeURIComponent(p.token)}`,
      fallbackLabel: "Reset on this device instead",
      expiryNote: "These numbers work for 1 hour, once. Your current password still works until you change it.",
      subject: "Reset your password · Aperture",
    },
    to,
  );
}

export function codeEmail(to: string, p: { purpose: "VERIFY" | "RESET"; code: string }): MailMessage {
  const isReset = p.purpose === "RESET";
  const title = isReset ? "Your password reset code" : "Your verification code";
  const intro = "Type this on the screen that asked for it.";
  const expiryNote = isReset ? "This code works for 1 hour, once." : "This code works for 24 hours, once.";
  const body = `${heading(title, intro)}
          <tr>
            <td style="padding:22px 24px 0 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:${BRAND.ground};border:1px solid ${BRAND.line};border-radius:12px;">
                <tr>
                  <td align="center" style="padding:18px;font-family:${FONT};">
                    <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};">Your code</div>
                    <div style="margin-top:8px;font-size:34px;font-weight:700;letter-spacing:8px;color:${BRAND.ink};font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;">${esc(p.code)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px 26px 24px;font-family:${FONT};">
              <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${esc(expiryNote)}</p>
            </td>
          </tr>`;
  return {
    to,
    subject: `${title} · Aperture`,
    html: frame(title, `Your code is ${p.code}`, body, "If you didn't ask for this, you can ignore this email."),
    text: [title, "", intro, "", `Code: ${p.code}`, "", expiryNote].join("\n"),
  };
}
