import { BUDGET_MAX_DECICENTS, BUDGET_MIN_DECICENTS, newPeopleBounds } from "../../config/plans.js";
import { hasCard, isOffSessionConsent } from "../billing/billing.service.js";
import { formatUsd, MAX_TOPUP, validateTopup } from "../../domain/money.js";
import { mandateText } from "../billing/autoReload.js";
import type { IntegrationProvider, OrgSettings, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, unprocessable, notConfigured } from "../../lib/errors.js";
import { isValidTimeZone } from "../../lib/time.js";
import { features } from "../../config/env.js";
import { getSettings } from "../../domain/settings.js";
import { canStartSequence, dailyVolumeLimit, isFunded } from "../../domain/entitlements.js";
import { creditPacing, WORKING_DAYS_PER_MONTH } from "../../domain/usage.js";
import { hasConsent } from "../../domain/launch.js";
import { budgetView, emailsPerDay } from "../../domain/budget.js";
import { credentialStatuses, deleteCredential, setCredential, getCredential } from "../../integrations/credentials.js";
import { verifierFor } from "../../integrations/verifier.js";

export type SettingsPatch = Partial<
  Pick<
    OrgSettings,
    | "autopilotEnabled" | "weeklyBatchMode" | "autoApproveBatches" | "leadSourcing" | "perMailboxDailyCap" | "blocklistNoReplyDays"
    | "timezone" | "sendingWindowStart" | "sendingWindowEnd" | "language" | "matchProspectLanguage" | "personalizationEnabled" | "requireVerifiedEmail"
    | "monthlyCreditCap" | "dailyCreditCap" | "dailySourceTarget" | "apolloCycleResetDay" | "perCompanyContactCap"
    | "senderCompany" | "senderTitle" | "senderAddress" | "meetingLink" | "valueProp" | "optOutLine" | "browserNotifications"
    | "draftReplies" | "launchMode" | "sendDays" | "prospectTimezone"
  >
> & { dailyBudgetDecicents?: string | null; autoReloadEnabled?: boolean; autoReloadThresholdDecicents?: string; autoReloadAmountDecicents?: string; autoReloadSetupIntentId?: string; proofPoints?: { claim: string; source: string }[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const BOOKING_LINK = /^https:\/\/[^\s]+$/i;

/** Settings as the API returns them: money as decimal strings, never a bigint in JSON. */
function shape(s: OrgSettings) {
  const str = (v: bigint | null) => (v === null ? null : v.toString());
  // Who accepted the auto-reload mandate and from which IP stays on the server; the customer sees the sentence and when.
  const { autoReloadMandateIp: _ip, autoReloadMandateUserId: _user, ...rest } = s;
  return { ...rest, dailyBudgetDecicents: str(s.dailyBudgetDecicents), autoReloadThresholdDecicents: str(s.autoReloadThresholdDecicents), autoReloadAmountDecicents: str(s.autoReloadAmountDecicents) };
}

export async function view(orgId: string) {
  const [settings, credentials, budget, consent] = await Promise.all([getSettings(orgId), credentialStatuses(orgId), budgetView(orgId), hasConsent(orgId)]);
  return {
    settings: shape(settings),
    credentials,
    budget,
    consentOnRecord: consent,
    limits: {
      maxDailyVolume: dailyVolumeLimit(),
      workingDaysPerMonth: WORKING_DAYS_PER_MONTH,
    },
    aiAvailable: features.ai,
  };
}

export async function update(orgId: string, patch: SettingsPatch, actor?: { userId: string; ip?: string | null }) {
  const current = await getSettings(orgId);
  const { dailyBudgetDecicents, proofPoints, autoReloadEnabled, autoReloadThresholdDecicents, autoReloadAmountDecicents, autoReloadSetupIntentId, ...rest } = patch;
  const data: Prisma.OrgSettingsUpdateInput = { ...rest };
  if (dailyBudgetDecicents !== undefined) data.dailyBudgetDecicents = dailyBudgetDecicents === null ? null : BigInt(dailyBudgetDecicents);
  if (proofPoints !== undefined) data.proofPoints = proofPoints as unknown as Prisma.InputJsonValue;
  if (autoReloadThresholdDecicents !== undefined) {
    const t = BigInt(autoReloadThresholdDecicents);
    if (t <= 0n || t > MAX_TOPUP) throw unprocessable("Choose a balance to top up at");
    data.autoReloadThresholdDecicents = t;
  }
  if (autoReloadAmountDecicents !== undefined) {
    const a = BigInt(autoReloadAmountDecicents);
    const problem = validateTopup(a);
    if (problem) throw unprocessable(`Auto-reload: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
    data.autoReloadAmountDecicents = a;
  }
  const turningOn = autoReloadEnabled === true;
  const changingWhileOn = current.autoReloadEnabled && autoReloadEnabled !== false && (autoReloadThresholdDecicents !== undefined || autoReloadAmountDecicents !== undefined);
  if (autoReloadEnabled === false) data.autoReloadEnabled = false;
  if (turningOn || changingWhileOn) {
    // Switching it on, or changing its numbers, needs a saved card and both numbers, and records the mandate: the
    // exact sentence on screen, who agreed to it, when and from where. It also clears an earlier switch-off.
    const threshold = (data.autoReloadThresholdDecicents as bigint | undefined) ?? current.autoReloadThresholdDecicents;
    const amount = (data.autoReloadAmountDecicents as bigint | undefined) ?? current.autoReloadAmountDecicents;
    if (threshold === null || amount === null) throw unprocessable("Choose when to top up and how much before switching auto-reload on");
    if (!(await hasCard(orgId))) throw unprocessable("Add a card first. Auto-reload charges the card you saved.");
    // Switching it on needs its own consent to charges while the customer is away: a confirmed off-session
    // SetupIntent on their saved card. The card added at setup only allows charges they make themselves.
    if (turningOn && !current.autoReloadEnabled && !(autoReloadSetupIntentId && (await isOffSessionConsent(orgId, autoReloadSetupIntentId))))
      throw unprocessable("Confirm auto-reload with your card first.");
    if (!actor) throw unprocessable("Auto-reload has to be switched on by a person");
    data.autoReloadEnabled = true;
    data.autoReloadMandateText = mandateText(threshold, amount);
    data.autoReloadMandateAcceptedAt = new Date();
    data.autoReloadMandateUserId = actor.userId;
    data.autoReloadMandateIp = actor.ip?.slice(0, 64) ?? null;
    data.autoReloadDisabledAt = null;
    data.autoReloadDisabledReason = null;
  }

  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw badRequest("Unknown time zone");
  if (patch.prospectTimezone && !isValidTimeZone(patch.prospectTimezone)) throw badRequest("Unknown time zone for your prospects");
  for (const key of ["sendingWindowStart", "sendingWindowEnd"] as const) {
    if (patch[key] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch[key]))) throw badRequest("Use HH:MM for the sending window");
  }
  const start = patch.sendingWindowStart ?? current.sendingWindowStart;
  const end = patch.sendingWindowEnd ?? current.sendingWindowEnd;
  if (start >= end) throw badRequest("The sending window must end after it starts");
  if (patch.sendDays !== undefined) {
    const days = [...new Set(patch.sendDays)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
    if (!days.length) throw badRequest("Pick at least one sending day");
    data.sendDays = days;
  }
  if (patch.meetingLink !== undefined && patch.meetingLink && !BOOKING_LINK.test(patch.meetingLink)) throw badRequest("The booking link must start with https://");
  if (patch.launchMode === "AUTO" && current.launchMode !== "AUTO" && !(await hasConsent(orgId))) {
    throw unprocessable("Confirm you are authorised to send on your company's behalf before switching to automatic launch.");
  }

  if (patch.perMailboxDailyCap !== undefined) data.perMailboxDailyCap = clamp(patch.perMailboxDailyCap, 1, 60);
  if (patch.blocklistNoReplyDays !== undefined) data.blocklistNoReplyDays = clamp(patch.blocklistNoReplyDays, 3, 60);
  if (patch.apolloCycleResetDay !== undefined) data.apolloCycleResetDay = clamp(patch.apolloCycleResetDay, 1, 28);
  if (patch.perCompanyContactCap !== undefined) data.perCompanyContactCap = clamp(patch.perCompanyContactCap, 1, 10);

  if (dailyBudgetDecicents !== undefined && dailyBudgetDecicents !== null) {
    const b = BigInt(dailyBudgetDecicents);
    if (b !== 0n && (b < BUDGET_MIN_DECICENTS || b > BUDGET_MAX_DECICENTS)) throw unprocessable(`The daily budget is $0 (paused) or between ${formatUsd(BUDGET_MIN_DECICENTS)} and ${formatUsd(BUDGET_MAX_DECICENTS)}`);
    // Finding follows sending: the budget's emails carry a quarter as many new people, so finding more only piles up.
    if (patch.dailySourceTarget === undefined && b > 0n) data.dailySourceTarget = Math.max(1, newPeopleBounds(emailsPerDay({ dailyBudgetDecicents: b })).max);
  }
  if (patch.draftReplies === true && !features.ai) throw notConfigured("AI (needed to draft replies)");
  if (patch.autopilotEnabled === true && !current.autopilotEnabled) {
    if (!(await isFunded(orgId))) throw unprocessable("Add credits before switching the autopilot on");
  }

  await prisma.orgSettings.update({ where: { organizationId: orgId }, data });
  if (dailyBudgetDecicents != null || patch.autopilotEnabled === true) {
    const { reportShortfall } = await import("../../domain/capacity.js");
    await reportShortfall(orgId, "daily budget changed").catch(() => undefined);
  }
  return view(orgId);
}

export async function saveCredential(orgId: string, provider: IntegrationProvider, value: string) {
  if (provider === "SLACK_WEBHOOK" && !/^https:\/\/hooks\.slack\.com\/services\//.test(value)) throw badRequest("That isn't a Slack incoming webhook URL");
  if (value.length < 8) throw badRequest("That key looks too short");
  await setCredential(orgId, provider, value);
  return credentialStatuses(orgId);
}

export async function removeCredential(orgId: string, provider: IntegrationProvider) {
  await deleteCredential(orgId, provider);
  return credentialStatuses(orgId);
}

export async function verifyEmail(orgId: string, email: string) {
  const verify = await verifierFor(orgId);
  if (!verify) throw notConfigured("MillionVerifier");
  return verify(email);
}

export async function autopilotStatus(orgId: string) {
  const s = await getSettings(orgId);
  const [funded, pacing, apollo, verifier, campaigns, csvQueued] = await Promise.all([
    canStartSequence(orgId),
    creditPacing(orgId, s),
    getCredential(orgId, "APOLLO"),
    getCredential(orgId, "MILLIONVERIFIER"),
    prisma.campaign.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
    prisma.contact.count({ where: { organizationId: orgId, source: "csv", status: { in: ["NEW", "PERSONALIZED", "QUEUED"] } } }),
  ]);
  // Customers buy emails, not infrastructure: nothing here mentions mailboxes, domains or inbox counts.
  const readiness = [
    { key: "credits", label: "Credits for the next emails", ok: funded },
    { key: "ai", label: "AI writing", ok: features.ai },
    { key: "apollo", label: "Lead sourcing", ok: !!apollo },
    // Nothing goes out unverified, so verification is required, not optional.
    { key: "verifier", label: "Email verification", ok: !!verifier },
    { key: "campaign", label: "A running campaign", ok: campaigns > 0 },
    { key: "meeting", label: "Booking link", ok: !!s.meetingLink, optional: true },
  ];
  return {
    on: s.autopilotEnabled,
    readiness,
    ready: readiness.filter((r) => !r.optional).every((r) => r.ok),
    sending: { dailyTarget: emailsPerDay(s), csvQueued },
    sourcing: { dailyTarget: s.dailySourceTarget, pacing },
  };
}
