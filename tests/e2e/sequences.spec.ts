import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe.serial("email sequences (dry run)", () => {
  test("load config, approve a wait, enrol a lead: the batch is a dry run and fails closed on missing evidence", async ({ page }) => {
    await signIn(page);
    await page.goto("/outreach");
    await page.getByRole("button", { name: "Load outreach config" }).click();

    const status = page.getByTestId("sequence-status");
    await expect(status).toContainText("DRY RUN: nothing is sent");
    await expect(status).toContainText("Launch Command: Stop");
    await expect(page.getByRole("heading", { name: "SA-CON: SA Contractors" })).toBeVisible();
    await expect(page.getByText("not approved (held)").first()).toBeVisible();

    await page.getByLabel("SA-CON S02 wait days").fill("4");
    await page.getByLabel("SA-CON S02 wait days").locator("xpath=ancestor::form").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("approved: 4 days")).toBeVisible();

    await page.getByText(/Add South African leads/).click();
    await page.getByLabel(/Johan Botha · Managing Director/).check();
    await page.getByRole("button", { name: "Add to campaign" }).click();
    const row = page.getByTestId("sequence-member").filter({ hasText: "Johan Botha" });
    await expect(row).toContainText("pending approval");
    await row.getByRole("button", { name: "Final approval" }).click();
    await expect(page.getByTestId("sequence-member").filter({ hasText: "Johan Botha" })).toContainText("active");

    await page.getByRole("button", { name: "Run batch now" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Dry run:" })).toBeVisible();
    const held = page.getByTestId("sequence-member").filter({ hasText: "Johan Botha" });
    await expect(held).toContainText("hold");
    await expect(held).toContainText("EMAIL_NOT_VERIFIED");
    await expect(held).toContainText("PERMISSION_MISSING");
    await expect(page.getByTestId("sequence-email")).toHaveCount(0);
  });
});
