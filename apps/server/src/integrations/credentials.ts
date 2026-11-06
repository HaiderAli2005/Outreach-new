import type { IntegrationProvider } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { env } from "../config/env.js";

const PLATFORM_FALLBACK: Record<IntegrationProvider, string | undefined> = {
  APOLLO: env.APOLLO_API_KEY,
  MILLIONVERIFIER: env.MILLIONVERIFIER_API_KEY,
  SLACK_WEBHOOK: env.SLACK_WEBHOOK_URL,
  GOOGLE_PLACES: env.GOOGLE_PLACES_API_KEY,
};

export async function getCredential(orgId: string, provider: IntegrationProvider): Promise<string | null> {
  const row = await prisma.integrationCredential.findUnique({ where: { organizationId_provider: { organizationId: orgId, provider } } });
  if (row) {
    try {
      return decrypt(row.ciphertext);
    } catch {
      return null;
    }
  }
  return PLATFORM_FALLBACK[provider] ?? null;
}

export async function setCredential(orgId: string, provider: IntegrationProvider, value: string): Promise<void> {
  const trimmed = value.trim();
  await prisma.integrationCredential.upsert({
    where: { organizationId_provider: { organizationId: orgId, provider } },
    create: { organizationId: orgId, provider, ciphertext: encrypt(trimmed), last4: trimmed.slice(-4) },
    update: { ciphertext: encrypt(trimmed), last4: trimmed.slice(-4) },
  });
}

export async function deleteCredential(orgId: string, provider: IntegrationProvider): Promise<void> {
  await prisma.integrationCredential.deleteMany({ where: { organizationId: orgId, provider } });
}

export interface CredentialStatus {
  provider: IntegrationProvider;
  source: "organization" | "platform" | null;
  masked: string | null;
}

export async function credentialStatuses(orgId: string): Promise<CredentialStatus[]> {
  const rows = await prisma.integrationCredential.findMany({ where: { organizationId: orgId } });
  return (Object.keys(PLATFORM_FALLBACK) as IntegrationProvider[]).map((provider) => {
    const own = rows.find((r) => r.provider === provider);
    if (own) return { provider, source: "organization", masked: `••••${own.last4}` };
    if (PLATFORM_FALLBACK[provider]) return { provider, source: "platform", masked: "platform key" };
    return { provider, source: null, masked: null };
  });
}
