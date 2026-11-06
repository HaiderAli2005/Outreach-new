import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiClient } from "../src/integrations/ai.js";

/** Azure OpenAI's v1 API takes the OpenAI request as is, at the resource's own URL, with the key in "api-key". */

afterEach(() => vi.unstubAllGlobals());

describe("Azure OpenAI", () => {
  it("sends each call to the Azure endpoint, with its key, to the deployment asked for", async () => {
    const calls: { url: string; headers: Headers; body: { model: string } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        const answer = { id: "c1", object: "chat.completion", created: 0, model: "gpt-5.6-tera", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: null };
        return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
      }),
    );
    const client = new OpenAiClient("az-key", "gpt-5.6-luna", "https://castroai.openai.azure.com/openai/v1");
    expect(await client.generateText("hi", { model: "gpt-5.6-tera" })).toBe("Hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://castroai.openai.azure.com/openai/v1/chat/completions");
    expect(calls[0].headers.get("api-key")).toBe("az-key");
    expect(calls[0].body.model).toBe("gpt-5.6-tera");
  });
});
