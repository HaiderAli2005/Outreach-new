import { afterEach, describe, expect, it } from "vitest";
import { api } from "./helpers.js";
import { setSiteChecker, siteFailureMessage } from "../src/integrations/site.js";

afterEach(() => setSiteChecker(null));

describe("site check at step 1", () => {
  it("answers before sign-up, with the reason in plain words", async () => {
    setSiteChecker(async (domain) => ({ domain, status: "unreadable", reason: "blocked", message: siteFailureMessage(domain, { kind: "blocked", status: 403 }), title: null }));
    const r = (await api().get("/api/v1/public/site-check?domain=https://www.Acme.io/about").expect(200)).body.data;
    expect(r).toMatchObject({ domain: "acme.io", status: "unreadable", message: "acme.io blocks automated visits (it answered 403)." });
  });

  it("refuses text that isn't a domain", async () => {
    await api().get("/api/v1/public/site-check?domain=not a domain").expect(400);
  });

  it("names each reason without codes", () => {
    expect(siteFailureMessage("acme.io", { kind: "missing" })).toBe("We can't find acme.io. Check the spelling and try again.");
    expect(siteFailureMessage("acme.io", { kind: "tls", code: "CERT_HAS_EXPIRED" })).not.toMatch(/CERT/);
    expect(siteFailureMessage("acme.io", { kind: "timeout" })).toBe("acme.io took too long to respond.");
  });
});
