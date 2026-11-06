import OpenAI from "openai";
import { env } from "../config/env.js";
import { notConfigured } from "../lib/errors.js";
import { recordAiUsage, type AiMeter } from "../domain/aiUsage.js";

export interface JsonSchema {
  /** Short identifier the API reports back, letters, digits, _ and - only. */
  name: string;
  schema: Record<string, unknown>;
}

export interface AiOptions {
  system?: string;
  /** For reasoning models this is the whole budget, thinking included, so give it room. */
  maxTokens?: number;
  /** Ignored by reasoning models, which do not take a temperature. */
  temperature?: number;
  /**
   * The model for this call, or several separated by commas in order of preference
   * ("gpt-6.1-sol,gpt-4.1"). A model the account can't use is skipped, and the default model is the last resort.
   */
  model?: string;
  /** Reasoning effort for reasoning models. */
  effort?: "low" | "medium" | "high";
  /** Strict structured output: the answer is guaranteed to match this JSON schema. */
  schema?: JsonSchema;
  /** Records the tokens this call really used, against a workspace and a purpose. */
  meter?: AiMeter;
}

export interface AiClient {
  generateJSON<T = Record<string, unknown>>(prompt: string, opts?: AiOptions): Promise<T | null>;
  generateText(prompt: string, opts?: AiOptions): Promise<string>;
}

/** gpt-5 and later, and the o-series, are reasoning models: no temperature, a completion budget that includes thinking. */
export const isReasoningModel = (model: string) => /^(?:gpt-(?:[5-9]|\d{2})|o[1-9])/i.test(model);

/** The chat completion request for one model. Exported so the shape can be tested without calling the API. */
export function requestParams(prompt: string, opts: AiOptions & { model: string }, json: boolean, useSchema = true) {
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  const reasoning = isReasoningModel(opts.model);
  const format = !json
    ? {}
    : opts.schema && useSchema
      ? { response_format: { type: "json_schema" as const, json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema } } }
      : { response_format: { type: "json_object" as const } };
  return {
    model: opts.model,
    messages,
    ...(reasoning
      ? { max_completion_tokens: opts.maxTokens ?? 4000, ...(opts.effort ? { reasoning_effort: opts.effort } : {}) }
      : { max_tokens: Math.min(opts.maxTokens ?? 900, 16_000), temperature: opts.temperature ?? 0.4 }),
    ...format,
  };
}

export class OpenAiClient implements AiClient {
  private readonly client: OpenAI;
  /** `baseURL` points at an OpenAI-compatible endpoint such as Azure's v1 API; Azure reads its key from "api-key". */
  constructor(apiKey: string, private readonly model: string, baseURL?: string) {
    this.client = baseURL ? new OpenAI({ apiKey, baseURL, defaultHeaders: { "api-key": apiKey } }) : new OpenAI({ apiKey });
  }

  /** Models this account turned out not to have, so they are not asked again until restart. */
  private readonly unavailable = new Set<string>();
  /** Models that rejected strict schemas, so they get plain JSON mode instead. */
  private readonly noSchema = new Set<string>();

  private candidates(opts: AiOptions): string[] {
    const wanted = (opts.model ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    return [...new Set([...wanted.filter((m) => !this.unavailable.has(m)), this.model])];
  }

  /** Tries each model in order; a model the account can't use is remembered and skipped. */
  private async withFallback<R>(opts: AiOptions, call: (model: string) => Promise<R>): Promise<R> {
    const list = this.candidates(opts);
    let last: unknown;
    for (const model of list) {
      try {
        return await call(model);
      } catch (err) {
        const e = err as { status?: number; code?: string; message?: string };
        const missing = e.status === 404 || e.code === "model_not_found" || ((e.status === 400 || e.status === 403) && /model/i.test(e.message ?? "") && !/response_format|json_schema|schema/i.test(e.message ?? ""));
        if (!missing || model === this.model) throw err;
        this.unavailable.add(model);
        last = err;
      }
    }
    throw last;
  }

  private async complete(prompt: string, opts: AiOptions, model: string, json: boolean) {
    const useSchema = !this.noSchema.has(model);
    try {
      return await this.client.chat.completions.create(requestParams(prompt, { ...opts, model }, json, useSchema) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      // Older models without strict schemas still answer in plain JSON mode; the validator checks the shape after.
      if (json && opts.schema && useSchema && e.status === 400 && /response_format|json_schema|schema/i.test(e.message ?? "")) {
        this.noSchema.add(model);
        return this.client.chat.completions.create(requestParams(prompt, { ...opts, model }, json, false) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      }
      throw err;
    }
  }

  private async measured(prompt: string, opts: AiOptions, json: boolean) {
    const res = await this.withFallback(opts, (model) => this.complete(prompt, opts, model, json));
    if (opts.meter) await recordAiUsage(opts.meter, res.model, res.usage);
    return res;
  }

  async generateJSON<T>(prompt: string, opts: AiOptions = {}): Promise<T | null> {
    const res = await this.measured(prompt, opts, true);
    const choice = res.choices?.[0];
    const refusal = (choice?.message as { refusal?: string | null } | undefined)?.refusal;
    if (refusal) throw new Error(`the AI declined: ${refusal.slice(0, 160)}`);
    const text = String(choice?.message?.content ?? "").trim();
    if (!text) throw new Error(`empty AI completion (${choice?.finish_reason ?? "unknown"})`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async generateText(prompt: string, opts: AiOptions = {}): Promise<string> {
    const res = await this.measured(prompt, opts, false);
    return String(res.choices?.[0]?.message?.content ?? "").trim();
  }
}

let override: AiClient | null | undefined;
let cached: AiClient | null | undefined;

export function getAi(): AiClient | null {
  if (override !== undefined) return override;
  if (cached === undefined) {
    // Azure, once its endpoint is set, is the only provider: its deployment names mean nothing to OpenAI.
    const azure = env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, "");
    const key = azure ? env.AZURE_OPENAI_API_KEY : env.OPENAI_API_KEY;
    cached = key ? new OpenAiClient(key, env.OPENAI_MODEL, azure) : null;
  }
  return cached;
}

export function requireAi(): AiClient {
  const ai = getAi();
  if (!ai) throw notConfigured(env.AZURE_OPENAI_ENDPOINT ? "AI (AZURE_OPENAI_API_KEY)" : "AI (OPENAI_API_KEY)");
  return ai;
}

export function setAiClient(client: AiClient | null | undefined): void {
  override = client;
}
