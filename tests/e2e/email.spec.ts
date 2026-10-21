import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe.serial("email via your mailbox (simulated)", () => {
  test("draft → approve → send: accepted is not delivered; a reply proves delivery and lands in the inbox", async ({ page }) => {
    await signIn(page);
    await page.goto("/email");
    await expect(page.getByTestId("mailbox").filter({ hasText: "Simulated mailbox" })).toContainText("enabled");

    await page.getByLabel("Select Naledi Khumalo").check();
    await page.getByLabel("Select Sipho Dlamini").check(); // no EMAIL consent → skipped
    await page.getByRole("button", { name: "Generate email drafts" }).click();
    await expect(page.getByRole("status")).toContainText("1 draft(s) created, 1 skipped: POPIA s69: EMAIL");

    const pending = page.getByTestId("pending-email").filter({ hasText: "Naledi" });
    await expect(pending.getByLabel("Email body")).toHaveValue(/Demo Co[\s\S]*unsubscribe/);
    await pending.getByLabel("Subject").fill("Quick question for Umhlanga Medical");
    await pending.getByRole("button", { name: "Approve" }).click();

    const ready = page.getByTestId("ready-email").filter({ hasText: "Naledi" });
    await ready.getByRole("button", { name: "Send (simulated)" }).click();

    const row = page.getByRole("row", { name: /Naledi Khumalo/ });
    await expect(row).toContainText(/accepted by mail server\s*· mail server accepted it/);
    await expect(row).not.toContainText("delivered");

    await row.getByLabel("Simulated reply type").selectOption("interested");
    await row.getByRole("button", { name: "Go" }).click();
    await expect(page.getByRole("row", { name: /Naledi Khumalo/ })).toContainText(/delivered \(receipt\)\s*· recipient replied/);

    await page.goto("/today");
    await expect(page.getByTestId("today-inbox")).toContainText("need");
    await page.getByTestId("today-inbox").click();
    const item = page.getByTestId("inbox-item").filter({ hasText: "Naledi" });
    await expect(item).toContainText("interested");
    await expect(item).toContainText("Sounds good");
    await item.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("inbox-item").filter({ hasText: "Naledi" })).toHaveCount(0);

    await page.goto("/email");
    await page.getByRole("link", { name: "Naledi Khumalo" }).first().click();
    await expect(page.getByTestId("thread-message")).toHaveCount(2);

    await page.goto("/reports");
    await expect(page.getByTestId("email-report")).toContainText("Proven delivered1");
  });

  test("admin: a new Hostinger mailbox starts disabled and can't be enabled before a successful test", async ({ page }) => {
    await signIn(page);
    await page.goto("/email/accounts");
    await page.getByLabel("Label").fill("Sales");
    await page.getByLabel("Sender name").fill("Thabo at Demo Co");
    await page.getByLabel(/^Email address/).fill("sales@demo-co.example");
    await page.getByLabel("Mailbox password").fill("not-a-real-password");
    await page.getByRole("button", { name: "Save mailbox" }).click();
    const box = page.getByTestId("mailbox-admin").filter({ hasText: "sales@demo-co.example" });
    await expect(box).toContainText("disabled");
    await expect(box).toContainText("smtp.hostinger.com:465");
    await box.getByRole("button", { name: "Enable" }).click();
    await expect(box.getByRole("alert")).toContainText("Run a successful connection test before enabling");
  });
});
