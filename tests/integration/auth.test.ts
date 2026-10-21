import { beforeEach, describe, expect, it } from "vitest";
import { db, makeUser, resetDb } from "./helpers";
import { isLocked, login, logout, resolveSession } from "@/server/auth/sessions";

beforeEach(resetDb);

describe("sessions", () => {
  it("logs in, resolves the session, and logs out", async () => {
    const u = await makeUser("OPERATOR");
    const res = await login(db, "OPERATOR@test.local", "password-1234");
    if ("error" in res) throw new Error(res.error);
    expect(res.user.role).toBe("OPERATOR");
    // token stored hashed, never in plaintext
    expect(await db.session.count({ where: { id: res.token } })).toBe(0);
    expect((await resolveSession(db, res.token))?.id).toBe(u.id);
    await logout(db, res.token);
    expect(await resolveSession(db, res.token)).toBeNull();
    const actions = (await db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["auth.login", "auth.logout"]);
  });

  it("rejects bad passwords, inactive users and locks after repeated failures", async () => {
    const u = await makeUser("VIEWER", "lock@test.local");
    for (let i = 0; i < 5; i++) expect(await login(db, "lock@test.local", "nope")).toEqual({ error: "Invalid email or password" });
    expect(isLocked("lock@test.local")).toBe(true);
    expect(await login(db, "lock@test.local", "password-1234")).toEqual({ error: "Too many attempts. Try again later." });
    expect(await db.auditLog.count({ where: { action: "auth.login_failed" } })).toBe(5);

    await db.user.update({ where: { id: u.id }, data: { active: false } });
    await makeUser("VIEWER", "inactive@test.local").then((x) => db.user.update({ where: { id: x.id }, data: { active: false } }));
    expect(await login(db, "inactive@test.local", "password-1234")).toHaveProperty("error");
  });

  it("expired sessions do not resolve", async () => {
    const u = await makeUser();
    const res = await login(db, u.email, "password-1234");
    if ("error" in res) throw new Error(res.error);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(db, res.token)).toBeNull();
  });
});
