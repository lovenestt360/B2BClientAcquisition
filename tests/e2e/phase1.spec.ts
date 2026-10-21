import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("redirects anonymous users to login and rejects bad credentials", async ({ page }) => {
  await page.goto("/contacts");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid" })).toHaveText("Invalid email or password");
});

test("dashboard shows seeded simulated pipeline and safety banner", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("mode-banner")).toContainText("SIMULATION MODE");
  await expect(page.getByTestId("mode-banner")).toContainText("DISABLED");
  await expect(page.getByText("8 simulated")).toBeVisible();
});

test("import CSV: preview, dedupe, commit, then contacts are searchable", async ({ page }) => {
  await signIn(page);
  await page.goto("/import");
  const csv = [
    "Name,Email,Mobile,Company,Country",
    "Grace Hopper,grace@navy-sim.example,082 555 0101,Navy Sim (Pty) Ltd,ZA",
    "Grace Hopper,GRACE@navy-sim.example,,Navy Sim,ZA",
    "Thandi Mokoena,thandi.mokoena@karoo-logistics.example,,Karoo Logistics,ZA",
    ",missing@name.example,,,",
  ].join("\n");
  await page.getByLabel("File").setInputFiles({ name: "e2e-leads.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload & preview" }).click();
  await page.waitForURL(/\/import\/.+/);
  const counts = page.getByTestId("import-counts");
  await expect(counts).toContainText("New1");
  await expect(counts).toContainText("Merge into existing1");
  await expect(counts).toContainText("Duplicates in file1");
  await expect(counts).toContainText("Invalid1");
  await page.getByRole("button", { name: /Commit 2 rows/ }).click();
  await expect(page.getByRole("status")).toContainText("1 created, 1 merged");

  await page.goto("/contacts?q=hopper");
  await expect(page.getByRole("link", { name: "Grace Hopper" })).toBeVisible();
  await page.getByRole("link", { name: "Grace Hopper" }).click();
  await expect(page.getByText("+27825550101")).toBeVisible();
  await expect(page.getByText(/source: import:/)).toBeVisible();
});

test("RBAC: viewer cannot see admin pages or write", async ({ page }) => {
  await signIn(page, "viewer@example.com");
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
  const res = await page.goto("/users");
  expect(res?.status()).toBeGreaterThanOrEqual(400);
});

test("@mobile dashboard is usable at iPhone width", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "Contacts" }).click();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
