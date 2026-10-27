import { describe, expect, it } from "vitest";
import { assertCan, can } from "@/server/auth/rbac";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { emailChangeInput, passwordChangeInput } from "@/server/auth/account";
import { decryptSecret, encryptSecret } from "@/server/crypto";

describe("RBAC", () => {
  it("enforces role hierarchy", () => {
    expect(can("VIEWER", "crm.read")).toBe(true);
    expect(can("VIEWER", "crm.write")).toBe(false);
    expect(can("OPERATOR", "outreach.execute")).toBe(true);
    expect(can("OPERATOR", "outreach.approve")).toBe(false);
    expect(can("MANAGER", "outreach.approve")).toBe(true);
    expect(can("MANAGER", "providers.manage")).toBe(false);
    expect(can("ADMIN", "providers.manage")).toBe(true);
    expect(() => assertCan("VIEWER", "import.run")).toThrow(/import.run/);
  });
});

describe("passwords", () => {
  it("hashes and verifies; rejects short passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow();
  });
});

describe("administrator credential changes", () => {
  it("normalizes the new email and requires the current password", () => {
    expect(emailChangeInput.parse({ email: "  Admin@Example.COM ", currentPassword: "current" }).email).toBe("admin@example.com");
    expect(() => emailChangeInput.parse({ email: "not-an-email", currentPassword: "" })).toThrow();
  });

  it("requires a strong matching new password", () => {
    expect(passwordChangeInput.parse({ currentPassword: "current", newPassword: "new password 123", confirmPassword: "new password 123" }).newPassword).toBe("new password 123");
    expect(() => passwordChangeInput.parse({ currentPassword: "current", newPassword: "new password 123", confirmPassword: "different password" })).toThrow(/do not match/);
  });
});

describe("secret encryption", () => {
  it("round-trips and detects tampering", () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    const blob = encryptSecret("s3cret");
    expect(blob).not.toContain("s3cret");
    expect(decryptSecret(blob)).toBe("s3cret");
    const tampered = Buffer.from(blob, "base64");
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSecret(tampered.toString("base64"))).toThrow();
  });
});
