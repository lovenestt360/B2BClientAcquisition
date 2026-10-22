import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe.serial("iPhone-assisted SMS & calling, voice sandbox", () => {
  test("providers: real channels start disabled; admin enables iPhone channels and sets a test number", async ({ page }) => {
    await signIn(page);
    await page.goto("/providers");
    const sms = page.getByTestId("provider-iphone_manual_sms");
    await expect(sms).toContainText("disabled");
    await expect(sms).toContainText("No delivery reports");
    await expect(page.getByTestId("provider-asterisk_sip_ai")).toContainText("Blocked: ALLOW_AUTOMATED_OUTREACH is not enabled");
    await expect(page.getByText(/No SIM provisioning data is stored/)).toBeVisible();

    for (const key of ["iphone_manual_sms", "iphone_manual_call"]) {
      const card = page.getByTestId(`provider-${key}`);
      await card.getByLabel("Enabled").check();
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByRole("status")).toHaveText("Saved");
    }
    await page.getByLabel("Test number for dummy leads (e.g. your second phone)").fill("082 999 0000");
    await page.getByLabel("SMS rate estimate (R / segment)").fill("0.50"); // decimals must be accepted
    await page.getByLabel("Call rate estimate (R / min)").fill("0.99");
    await page.getByRole("button", { name: "Save line settings" }).click();
    await expect(page.getByRole("button", { name: "Save line settings" }).locator("xpath=..").getByRole("status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByLabel("Test number for dummy leads (e.g. your second phone)")).toHaveValue("+27829990000");
    await expect(page.getByLabel("Call rate estimate (R / min)")).toHaveValue("0.99");
    await expect(page.getByTestId("provider-iphone_manual_sms")).toContainText("enabled");
  });

  test("SMS: draft for consented dummy lead → approve → open Messages → confirm; delivery stays unknown", async ({ page }) => {
    await signIn(page);
    await page.goto("/sms");
    await page.getByLabel("Select Aisha Patel").check();
    await page.getByLabel("Select Thandi Mokoena").check(); // no consent → skipped
    await page.getByRole("button", { name: "Generate drafts for selected" }).click();
    await expect(page.getByRole("status")).toContainText("1 draft(s) created, 1 skipped: POPIA s69");

    const pending = page.getByTestId("pending-draft");
    await expect(pending).toContainText("Aisha Patel");
    await expect(pending.getByLabel("Message text")).toHaveValue(/^Demo Co: .*Reply STOP to opt out$/);
    await pending.getByRole("button", { name: "Approve" }).click();

    const ready = page.getByTestId("ready-draft");
    await expect(ready).toContainText("Manual (you send/dial)");
    await ready.getByRole("button", { name: "Open in Messages (test)" }).click();
    await expect(ready.getByText(/Dummy lead: Messages opens addressed to your test number \+27829990000/)).toBeVisible();
    await expect(ready.getByRole("link", { name: "Tap here" })).toHaveAttribute("href", /^sms:\+27829990000&body=Demo%20Co%3A/);

    await ready.getByRole("button", { name: "I sent it" }).click();
    await page.reload();
    await expect(page.getByRole("row", { name: /Aisha Patel/ })).toContainText("delivery unknown");

    await page.getByRole("link", { name: "Aisha Patel" }).first().click();
    await expect(page.getByText(/You confirmed sending \(delivery unknown\) · evidence: user attestation/)).toBeVisible();
    await page.getByLabel("Reply text").fill("STOP");
    await page.getByRole("button", { name: "Save reply" }).click();
    await expect(page.getByRole("status")).toContainText("Opt-out recorded");
  });

  test("calls: queue dummy lead, dial via tel: (test number), record outcome", async ({ page }) => {
    await signIn(page);
    await page.goto("/calls");
    await page.getByLabel("Contact").selectOption({ label: "Johan Botha – Highveld Engineering CC (dummy)" });
    await page.getByRole("button", { name: "Add to call queue" }).click();
    const card = page.getByTestId("queued-call").filter({ hasText: "Johan Botha" });
    await expect(card).toContainText("Talking points");
    await expect(card).toContainText("cannot access iPhone call audio");
    await card.getByRole("button", { name: /Call Johan/ }).click();
    await expect(card.getByRole("link", { name: "Tap here" })).toHaveAttribute("href", "tel:+27829990000");
    await page.reload();
    await card.getByLabel("Outcome").selectOption("MEETING_BOOKED");
    await card.getByLabel("Duration in minutes").fill("3");
    await card.getByRole("button", { name: "Save outcome" }).click();
    await expect(page.getByRole("row", { name: /Johan Botha/ })).toContainText("meeting booked");
  });

  test("voice sandbox: AI disclosure, truthful identity answer, emergency hang-up, transcript stored", async ({ page }) => {
    await signIn(page);
    await page.goto("/voice");
    await page.getByRole("button", { name: "Start simulated call" }).click();
    const t = page.getByTestId("sandbox-transcript");
    await expect(t).toContainText("this is an AI assistant calling on behalf of Demo Co");
    await page.getByLabel("Your reply").fill("Hang on, are you a robot?");
    await page.getByRole("button", { name: "Say" }).click();
    await expect(t).toContainText("Yes, I'm an AI assistant calling on behalf of Demo Co");
    await page.getByRole("button", { name: "Emergency hang-up" }).click();
    await expect(page.getByRole("status")).toContainText("Call ended: emergency hangup");
    await page.reload();
    await page.getByRole("link", { name: /\d{4}/ }).first().click();
    await expect(page.getByLabel("Transcript")).toContainText("Emergency hang-up by operator");
  });

  test("emergency stop halts and resumes outreach", async ({ page }) => {
    await signIn(page);
    await page.goto("/compliance");
    await page.getByLabel("Stop reason").fill("e2e drill");
    await page.getByRole("button", { name: "Stop all outreach now" }).click();
    await expect(page.getByText("EMERGENCY STOP ACTIVE")).toBeVisible();
    await page.goto("/sms");
    await expect(page.getByText("Emergency stop is active")).toBeVisible();
    await page.goto("/compliance");
    await page.getByRole("button", { name: "Resume outreach" }).click();
    await expect(page.getByText("EMERGENCY STOP ACTIVE")).toHaveCount(0);
  });

  test("reports reflect manual outcomes", async ({ page }) => {
    await signIn(page);
    await page.goto("/reports");
    await expect(page.getByText("SMS sent (you confirmed)")).toBeVisible();
    await expect(page.getByText("meeting booked")).toBeVisible();
    await expect(page.getByText("delivery unknown").first()).toBeVisible();
  });
});

test("@mobile SMS and call screens fit an iPhone", async ({ page }) => {
  await signIn(page);
  for (const path of ["/today", "/sms", "/calls", "/voice", "/providers", "/connect"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `${path} overflows horizontally`).toBe(false);
  }
});
