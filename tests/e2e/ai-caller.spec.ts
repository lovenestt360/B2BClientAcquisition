import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe.serial("AI sales caller (sandbox)", () => {
  test("playbook shows the slots the AI would offer", async ({ page }) => {
    await signIn(page);
    await page.goto("/playbook");
    await expect(page.getByLabel(/What you sell/)).toHaveValue(/^DEMO:/);
    await expect(page.getByTestId("sample-slots")).toContainText(/Right now the AI would offer: .* at \d\d:\d\d or .* at \d\d:\d\d/);
    await page.getByLabel(/Your name/).fill("Mario");
    await page.getByRole("button", { name: "Save playbook" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Playbook saved" })).toBeVisible();
  });

  test("calls a lead with a brief, handles 'busy', books a slot and lists the meeting", async ({ page }) => {
    await signIn(page);
    await page.goto("/voice");
    await page.getByLabel("Lead to call").selectOption({ label: "Zanele Mthembu – Baobab Financial Advisory (dummy)" });
    await page.getByRole("button", { name: "Start simulated call" }).click();
    const t = page.getByTestId("sandbox-transcript");
    await expect(t).toContainText("Hi Zanele, this is an AI assistant calling on behalf of Mario at Demo Co, speaking in Mario's voice.");
    await expect(page.getByTestId("sandbox-brief")).toContainText("Lead brief: Zanele Mthembu, COO at Baobab Financial Advisory");

    await page.getByLabel("Your reply").fill("Sorry, I'm in a meeting");
    await page.getByRole("button", { name: "Say" }).click();
    await expect(t).toContainText(/Would .* or .* work better for you\?/);
    await page.getByLabel("Your reply").fill("The first one works");
    await page.getByRole("button", { name: "Say" }).click();
    await expect(page.getByTestId("sandbox-booking")).toContainText(/Meeting booked: .* at \d\d:\d\d \(rehearsal/);
    await expect(t).toContainText("you're booked for");

    await page.goto("/meetings");
    const m = page.getByTestId("meeting").filter({ hasText: "Zanele" });
    await expect(m).toContainText("simulated");
    await m.getByRole("link", { name: "call transcript" }).click();
    await expect(page.getByLabel("Transcript")).toContainText("The first one works");
  });
});
