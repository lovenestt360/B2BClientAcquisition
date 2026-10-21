import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("laptop: grouped sidebar with badges and Connect phone QR", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/$/);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText("Outreach")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Tabs" })).toBeHidden();
  await sidebar.getByRole("link", { name: /Connect phone/ }).click();
  await expect(page.getByRole("heading", { name: "Connect your phone" })).toBeVisible();
  await expect(page.getByTestId("connect-qr").first().locator("svg")).toBeVisible();
  await expect(page.getByText("Add to Home Screen")).toBeVisible();
});

test("PWA: manifest, icons, service worker and offline page are public", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.ok()).toBe(true);
  expect(await m.json()).toMatchObject({ start_url: "/today", display: "standalone" });
  for (const p of ["/icon", "/apple-icon"]) {
    const r = await request.get(p);
    expect(r.headers()["content-type"]).toBe("image/png");
  }
  expect((await request.get("/sw.js")).ok()).toBe(true);
  expect(await (await request.get("/offline.html")).text()).toContain("Nothing was sent");
});

test("@mobile phone: lands on Today, drafts on SMS tab, sends from Today", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/today$/);
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();

  await tabs.getByRole("link", { name: /SMS/ }).click();
  await page.getByLabel("Select Lerato Nkosi").check();
  await page.getByRole("button", { name: "Generate drafts for selected" }).click();
  await expect(page.getByRole("status")).toContainText("1 draft(s) created");
  await page.getByTestId("pending-draft").filter({ hasText: "Lerato" }).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("ready-draft").filter({ hasText: "Lerato" })).toBeVisible();

  await tabs.getByRole("link", { name: /Today/ }).click();
  const card = page.getByTestId("ready-draft").filter({ hasText: "Lerato" });
  await card.getByRole("button", { name: /Open in Messages/ }).click();
  await expect(card.getByTestId("confirm-outcome")).toBeVisible();
  // Leaving for Messages may reload the page (as iOS Safari often does on return); the
  // confirmation step comes from server state, so it must survive a reload.
  await page.reload();
  await expect(card.getByTestId("confirm-outcome")).toBeVisible();
  await card.getByRole("button", { name: "I sent it" }).click();
  await page.reload();
  await expect(page.getByTestId("ready-draft").filter({ hasText: "Lerato" })).toHaveCount(0);
  await expect(page.getByTestId("today-stats")).toContainText(/SMS \+ email sent\s*[1-9]/i);

  // The More sheet reaches everything else
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: /Providers/ }).click();
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
});
