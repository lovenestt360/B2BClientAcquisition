import type { Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";

export async function signIn(page: Page, email = "admin@example.com") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(today)?$/); // phones land on /today, laptops on the dashboard
}
