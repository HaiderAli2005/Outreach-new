import type { OrganizationStatus, Prisma, UserStatus, PaymentStatus, WebhookProvider, WebhookStatus, LogLevel } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { refundPayment } from "../billing/billing.service.js";
import { balanceView } from "../../domain/credits/index.js";
import { verifierFor } from "../../integrations/verifier.js";

interface Page {
  page: number;
  limit: number;
}
const sk = (p: Page) => ({ skip: (p.page - 1) * p.limit, take: p.limit });

export async function overview() {
  const month = new Date(Date.now() - 30 * 86_400_000);
  const [users, orgs, funded, paused, warning, revenue, refunded, charged, sent30, replies30, failedWebhooks, critical, pendingRestock] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count(),
    prisma.creditLedger.groupBy({ by: ["organizationId"], where: { kind: { in: ["TOPUP", "BONUS"] } } }).then((r) => r.length),
    prisma.customerHealth.count({ where: { status: "PAUSED" } }),
    prisma.customerHealth.count({ where: { status: "WARNING" } }),
    prisma.payment.aggregate({ where: { status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] }, createdAt: { gte: month } }, _sum: { amountCents: true } }),
    prisma.payment.aggregate({ where: { createdAt: { gte: month } }, _sum: { amountRefundedCents: true } }),
    prisma.creditLedger.aggregate({ where: { kind: "CHARGE", createdAt: { gte: month } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.send.count({ where: { status: { in: ["SENT", "DELIVERED", "HARD_BOUNCE", "SOFT_BOUNCE", "COMPLAINT"] }, sentAt: { gte: month } } }),
    prisma.message.count({ where: { direction: "INBOUND", createdAt: { gte: month } } }),
    prisma.webhookEvent.count({ where: { status: "FAILED" } }),
    prisma.systemLog.count({ where: { level: "CRITICAL", resolvedAt: null } }),
    prisma.poolReorder.count({ where: { status: "PENDING" } }),
  ]);
  return {
    users,
    organizations: orgs,
    fundedCustomers: funded,
    pausedCustomers: paused,
    warningCustomers: warning,
    revenue30dCents: revenue._sum.amountCents ?? 0,
    refunded30dCents: refunded._sum.amountRefundedCents ?? 0,
    // Charges are negative ledger rows in deci-cents; shown as whole cents here.
    charged30dCents: Number(-(charged._sum.amount ?? 0n) / 10n),
    emailsCharged30d: charged._count._all,
    sent30d: sent30,
    replies30d: replies30,
    failedWebhooks,
    openCriticalLogs: critical,
    pendingRestock,
  };
}

export async function users(q: Page & { search?: string; status?: UserStatus }) {
  const where: Prisma.UserWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.search ? { OR: [{ email: { contains: q.search, mode: "insensitive" } }, { name: { contains: q.search, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...sk(q),
      select: { id: true, email: true, name: true, status: true, isPlatformAdmin: true, lastLoginAt: true, createdAt: true, memberships: { select: { role: true, organization: { select: { id: true, name: true } } } } },
    }),
    prisma.user.count({ where }),
  ]);
  return { rows, total };
}

export async function updateUser(actorId: string, id: string, data: { status?: UserStatus; isPlatformAdmin?: boolean }) {
  if (id === actorId && (data.status === "DISABLED" || data.isPlatformAdmin === false)) throw unprocessable("You can't disable or demote yourself");
  const user = await prisma.user.update({ where: { id }, data, select: { id: true, email: true, status: true, isPlatformAdmin: true } });
  if (data.status === "DISABLED") await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
  return user;
}

export async function organizations(q: Page & { search?: string; status?: OrganizationStatus }) {
  const where: Prisma.OrganizationWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { primaryDomain: { contains: q.search, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...sk(q),
      select: {
        id: true, name: true, primaryDomain: true, status: true, createdAt: true,
        health: { select: { status: true, bounceRate: true } },
        _count: { select: { memberships: true, contacts: true, campaigns: true } },
      },
    }),
    prisma.organization.count({ where }),
  ]);
  const verifying = await Promise.all(rows.map((r) => verifierFor(r.id).then((v) => !!v)));
  return { rows: rows.map((r, i) => ({ ...r, verifying: verifying[i] })), total };
}

export async function organization(id: string) {
  const org = await prisma.organization.findUnique({
    where: { id },
    include: {
      health: true,
      memberships: { include: { user: { select: { id: true, email: true, name: true } } } },
      settings: { select: { autopilotEnabled: true, draftReplies: true, launchMode: true, firstBatchApprovedAt: true, dailyBudgetDecicents: true, timezone: true } },
      _count: { select: { contacts: true, campaigns: true, messages: true, blocklist: true } },
    },
  });
  if (!org) throw notFound("Organization");
  const [payments, logs] = await Promise.all([
    prisma.payment.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.systemLog.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return { ...org, webhookToken: undefined, payments, logs, credits: await balanceView(id), verifying: !!(await verifierFor(id)) };
}

export async function updateOrganization(id: string, data: { status?: OrganizationStatus }) {
  const org = await prisma.organization.update({ where: { id }, data, select: { id: true, status: true } });
  if (data.status === "SUSPENDED") {
    await prisma.orgSettings.updateMany({ where: { organizationId: id }, data: { autopilotEnabled: false } });
  }
  return org;
}

export async function payments(q: Page & { status?: PaymentStatus }) {
  const where: Prisma.PaymentWhereInput = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: "desc" }, ...sk(q), include: { organization: { select: { id: true, name: true } }, refunds: true } }),
    prisma.payment.count({ where }),
  ]);
  return { rows, total };
}

export function refund(adminId: string, paymentId: string, amountCents?: number, reason?: string) {
  return refundPayment(paymentId, amountCents, reason, adminId);
}

export async function webhookEvents(q: Page & { provider?: WebhookProvider; status?: WebhookStatus }) {
  const where: Prisma.WebhookEventWhereInput = { ...(q.provider ? { provider: q.provider } : {}), ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.webhookEvent.findMany({ where, orderBy: { receivedAt: "desc" }, ...sk(q), select: { id: true, provider: true, type: true, status: true, error: true, organizationId: true, receivedAt: true, processedAt: true } }),
    prisma.webhookEvent.count({ where }),
  ]);
  return { rows, total };
}

export async function systemLogs(q: Page & { level?: LogLevel; open?: boolean }) {
  const where: Prisma.SystemLogWhereInput = { ...(q.level ? { level: q.level } : {}), ...(q.open ? { resolvedAt: null } : {}) };
  const [rows, total] = await Promise.all([
    prisma.systemLog.findMany({ where, orderBy: { createdAt: "desc" }, ...sk(q), include: { organization: { select: { id: true, name: true } } } }),
    prisma.systemLog.count({ where }),
  ]);
  return { rows, total };
}
