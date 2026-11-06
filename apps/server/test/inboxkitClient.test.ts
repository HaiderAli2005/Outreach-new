import { afterEach, describe, expect, it, vi } from "vitest";
import { errorText, placeOrder, verifyWebhookSignature, webhookSignature } from "../src/integrations/inboxkit.js";

/** The InboxKit client on its own: error shapes, order outcomes, and the webhook signature. */

afterEach(() => vi.unstubAllGlobals());

const ctx = { key: "ik_test_key_000000000000", workspace: "ws_1" };
const order = { contact: { first_name: "A", last_name: "B", email: "a@b.co", phone: "+1 555 0100", address_line1: "1 St", city: "X", state: "Y", country: "US", postal_code: "1" }, domains: [], warmup: true };

describe("InboxKit client", () => {
  it("reads every error shape InboxKit uses", () => {
    expect(errorText({ error: true, message: "Invalid API Key" }, 401)).toBe("Invalid API Key");
    expect(errorText({ code: 400, message: "Workspace ID is required" }, 400)).toBe("Workspace ID is required");
    expect(errorText([{ status: "error", message: "warmup_addon_enabled must be true or false" }], 400)).toBe("warmup_addon_enabled must be true or false");
    expect(errorText(null, 401)).toMatch(/refused the API key/);
  });

  it("tells a placed order, a refused one and one with no answer apart, and never retries an order by itself", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response(JSON.stringify([{ order_id: "o1", status: "a.com queued", domain: "a.com" }, { order_id: "o1", status: "error", domain: "b.com", message: "Domain b.com is not available", available: false }]), { status: 201 }),
      () => new Response(JSON.stringify([{ status: "error", message: "Insufficient wallet credit balance", total_cost: 24, available_credits: 20 }]), { status: 402 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("upstream", { status: 502 }),
    ];
    const fetch = vi.fn(async () => answers.shift()!());
    vi.stubGlobal("fetch", fetch);
    const placed = await placeOrder(ctx, order);
    expect(placed).toEqual({ kind: "placed", items: [expect.objectContaining({ domain: "a.com", queued: true, orderId: "o1" }), expect.objectContaining({ domain: "b.com", queued: false, nameProblem: true })] });
    expect(await placeOrder(ctx, order)).toMatchObject({ kind: "refused", status: 402, totalCost: 24, availableCredits: 20 });
    expect(await placeOrder(ctx, order)).toMatchObject({ kind: "unknown" });
    expect(await placeOrder(ctx, order)).toMatchObject({ kind: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(4);
    const [, init] = fetch.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ctx.key}`, "X-Workspace-Id": "ws_1" });
  });

  it("checks the webhook signature (sha256 of the API key) in constant time", () => {
    const sig = webhookSignature(ctx.key);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(ctx.key, sig)).toBe(true);
    expect(verifyWebhookSignature(ctx.key, sig.replace(/.$/, "0") === sig ? sig.replace(/.$/, "1") : sig.replace(/.$/, "0"))).toBe(false);
    expect(verifyWebhookSignature(ctx.key, undefined)).toBe(false);
    expect(verifyWebhookSignature("another_key_000000000000", sig)).toBe(false);
  });
});
