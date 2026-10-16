import nodemailer, { type Transporter } from "nodemailer";
import { env, features } from "../config/env.js";
import { logger } from "../lib/logger.js";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type MailSender = (message: MailMessage) => Promise<boolean>;

let transport: Transporter | null = null;
let override: MailSender | null | undefined;

function smtpSender(): MailSender | null {
  if (!features.mail) return null;
  transport ??= nodemailer.createTransport({
    host: env.MAIL_HOST,
    port: env.MAIL_PORT,
    secure: env.MAIL_PORT === 465,
    auth: { user: env.MAIL_USER!, pass: env.MAIL_PASS! },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  return async (message) => {
    try {
      const info = await transport!.sendMail({ from: env.MAIL_FROM, ...message });
      logger.info({ to: message.to, subject: message.subject, id: info.messageId }, "mail sent");
      return true;
    } catch (err) {
      logger.error({ to: message.to, subject: message.subject, err: (err as Error).message }, "mail failed");
      return false;
    }
  };
}

export function mailSender(): MailSender | null {
  return override === undefined ? smtpSender() : override;
}

export function mailEnabled(): boolean {
  return mailSender() !== null;
}

export async function sendMail(message: MailMessage): Promise<boolean> {
  const send = mailSender();
  if (!send) {
    logger.warn({ to: message.to, subject: message.subject }, "mail not configured, message dropped");
    return false;
  }
  return send(message);
}

export function setMailSender(sender: MailSender | null | undefined): void {
  override = sender;
}
