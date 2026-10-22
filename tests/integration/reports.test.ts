import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, grantConsent, makeContact, resetDb, setupOutreach } from "./helpers";
import { approveDraft, confirmSendOutcome, generateSmsDrafts, handOffDraft } from "@/server/messaging/sms";
import { seedSimulatedMailbox } from "@/server/email/accounts";
import { generateEmailDrafts } from "@/server/email/drafts";
import { approveEmailDraft, sendEmailDraft } from "@/server/email/send";
import { simulateReply } from "@/server/email/simulate";
import { outreachReport } from "@/server/reports";
import { listInbox } from "@/server/inbox";
import { MockLlmClient } from "@/server/ai/llm";
import { setClock } from "@/server/clock";

beforeEach(resetDb);
afterEach(() => setClock(null));
const llm = new MockLlmClient();

describe("reports and inbox keep channels apart", () => {
  it("SMS figures exclude email; email figures are evidence-based; inbox previews drop quoted text", async () => {
    const { admin, actor } = await setupOutreach();
    const smsLead = await makeContact();
    await grantConsent(smsLead.id, "SMS");
    const [smsId] = (await generateSmsDrafts(db, { contactIds: [smsLead.id], userId: admin.id }, llm)).created;
    await approveDraft(db, smsId, actor);
    await handOffDraft(db, smsId, actor);
    await confirmSendOutcome(db, smsId, "sent", actor);

    const sim = await seedSimulatedMailbox(db, true);
    const dummies = [await makeContact({ isSimulated: true }), await makeContact({ isSimulated: true })];
    for (const d of dummies) await grantConsent(d.id, "EMAIL");
    const ids = (await generateEmailDrafts(db, { contactIds: dummies.map((d) => d.id), accountId: sim.id, userId: admin.id }, llm)).created;
    const sent = [];
    for (const id of ids) {
      await approveEmailDraft(db, id, actor);
      sent.push(await sendEmailDraft(db, id, actor));
    }
    await simulateReply(db, sent[0].id, "interested", { llm });

    const r = await outreachReport(db, 30);
    expect(r.smsSent).toBe(1);
    expect(r.deliveryStates.map((d) => d.providerKey)).toEqual(["iphone_manual_sms"]);
    expect(r.email).toMatchObject({ sent: 2, deliveredByEvidence: 1, accepted: 1, interested: 1, humanReplies: 1 });

    const [item] = await listInbox(db);
    expect(item.preview).toBe("Hi, thanks for reaching out. Sounds good, let's chat next Tuesday morning.");
  });
});
