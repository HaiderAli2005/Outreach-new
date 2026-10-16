import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/integrations/site.js";

describe("outbound site reads", () => {
  it("never treats private, loopback or metadata addresses as fetchable", () => {
    for (const ip of ["10.0.0.4", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.9", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    for (const ip of ["8.8.8.8", "151.101.1.69", "2606:4700::6810:85e5"]) expect(isPublicAddress(ip)).toBe(true);
  });
});
