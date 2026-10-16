import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type AiPurpose = "analysis" | "sample-emails" | "personalize" | "fact-check" | "reply";

/** Who an AI call was for and why, so its tokens are recorded against it. */
export interface AiMeter {
  orgId: string | null;
  purpose: AiPurpose;
}

/** Tokens as the API reports them (chat completions usage). */
export interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Stores one call's real token use. Never fails the call it measures. */
export async function recordAiUsage(meter: AiMeter, model: string, usage: ApiUsage | null | undefined): Promise<void> {
  if (!usage) return;
  await prisma.aiUsage
    .create({
      data: {
        organizationId: meter.orgId,
        purpose: meter.purpose,
        model,
        inputTokens: usage.prompt_tokens ?? 0,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      },
    })
    .catch((e: Error) => logger.warn({ err: e.message, purpose: meter.purpose }, "ai usage not recorded"));
}
