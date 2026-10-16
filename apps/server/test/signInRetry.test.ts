import { describe, expect, it } from "vitest";
import { twice } from "../src/domain/sending/transport/smtp.js";

describe("mailbox sign-in check", () => {
  it("tries a timed-out sign-in once more, and never retries a refused password", async () => {
    let calls = 0;
    expect(await twice(async () => (++calls === 1 ? "IMAP: Socket timeout" : null))).toBeNull();
    expect(calls).toBe(2);

    calls = 0;
    expect(await twice(async () => (calls++, "SMTP: Invalid login: 535-5.7.8 Username and Password not accepted"))).toMatch(/535-5\.7\.8/);
    expect(calls).toBe(1);

    expect(await twice(async () => "IMAP: Socket timeout")).toMatch(/twice\)\. The mail server did not answer in time/);
  });
});
