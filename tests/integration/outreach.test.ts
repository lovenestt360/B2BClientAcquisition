import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, makeUser, resetDb, setupOutreach } from "./helpers";
import { setClock } from "@/server/clock";
import { MockLlmClient } from "@/server/ai/llm";
import { setEmergencyStop } from "@/server/compliance/controls";
import { seedSimulatedMailbox } from "@/server/email/accounts";
import { ingestRawEmail } from "@/server/email/ingest";
import { buildSimulatedRaw } from "@/server/email/simulate";
import { DryRunTransport, SmtpTransport, type MailTransport, type OutboundEmail } from "@/server/email/transport";
import {
  approveStepTiming,
  getOutreachSettings,
  LAUNCH_CONFIRMATION,
  loadConfigFile,
  resolveMode,
  saveOutreachSettings,
  setLaunch,
  syncOutreachConfig,
} from "@/server/outreach/config";
import { approveMember, approveOutreachSend, enrollContacts, reconcileUnknownSend, runOutreachBatch, sendOutreach } from "@/server/outreach/sequence";
import { followUpDue } from "@/server/outreach/schedule";
import { runStopWatch } from "@/server/outreach/stops";
import { outreachReconciliation } from "@/server/outreach/report";

const llm = new MockLlmClient();
const WED_10 = new Date("2026-10-21T08:05:00Z"); // Wednesday 10:05 Maputo
let actor: { id: string; role: string };
let adminId: string;

beforeEach(async () => {
  await resetDb();
  const s = await setupOutreach();
  actor = s.actor;
  adminId = s.admin.id;
  setClock(() => WED_10);
  await syncOutreachConfig(db, loadConfigFile(), adminId);
  await db.campaign.updateMany({ where: { key: { in: ["SA-CON", "SA-PM"] } }, data: { status: "ACTIVE" } });
});
afterEach(() => setClock(null));

/** Test-only wait: the real value must be approved by a human on /outreach. */
async function approveWaits(days = 3) {
  for (const st of await db.outreachStep.findMany({ where: { step: { gt: 1 } } })) await approveStepTiming(db, st.id, days, adminId);
}

let k = 0;
interface LeadOpts {
  title?: string;
  company?: string;
  industry?: string | null;
  project?: string | null;
  needs?: string[];
  consent?: "granted" | "requested" | "none";
  verified?: boolean;
  country?: string;
  approve?: boolean;
}
async function lead(campaignKey: "SA-CON" | "SA-PM", o: LeadOpts = {}) {
  k++;
  const company = await db.company.create({
    data: { name: o.company ?? `Firm${k} Holdings`, normalizedName: `firm${k} holdings`, industry: o.industry === undefined ? "Commercial construction" : o.industry, country: "ZA", domain: `firm${k}.example` },
  });
  const contact = await db.contact.create({
    data: {
      firstName: `Lead${k}`,
      lastName: "Test",
      fullNameNormalized: `lead${k} test`,
      title: o.title ?? (campaignKey === "SA-CON" ? "Project Director" : "Programme Director"),
      email: `lead${k}@firm${k}.example`,
      emailSource: "import:test",
      emailVerifiedAt: o.verified === false ? null : new Date("2026-10-01"),
      emailVerificationStatus: o.verified === false ? "Not checked" : "Valid",
      country: o.country ?? "ZA",
      companyId: company.id,
      sourceType: "import",
    },
  });
  const src = (i: number) => `https://research.example/${k}/${i}`;
  if (o.project !== null) {
    await db.researchFact.create({ data: { companyId: company.id, kind: "project", field: "project", value: o.project ?? `Riverside Clinic phase ${k}`, sourceUrl: src(0), confidence: 0.9, verifiedAt: new Date("2026-10-01") } });
  } else {
    await db.researchFact.create({ data: { companyId: company.id, kind: "fact", field: "services", value: "Programme management for public sector clients", sourceUrl: src(0), confidence: 0.9, verifiedAt: new Date("2026-10-01") } });
  }
  const needs = o.needs ?? (campaignKey === "SA-CON" ? ["Tender notes heavy MEP services installation", "Prefabricated steel procurement on a fast-track programme"] : ["Monthly client reporting on risk across a portfolio", "Design team coordination issues raised in meetings"]);
  for (const [i, v] of needs.entries()) {
    await db.researchFact.create({ data: { companyId: company.id, kind: "need_evidence", field: "need", value: v, sourceUrl: src(i + 1), confidence: 0.85, verifiedAt: new Date("2026-10-01") } });
  }
  const consent = o.consent ?? "granted";
  if (consent !== "none") {
    await db.marketingPermission.create({
      data: { contactId: contact.id, channel: "EMAIL", status: consent === "granted" ? "GRANTED" : "CONSENT_REQUESTED", basis: "CONSENT", evidence: "signed-up via klyron webinar form 2026-09-30", capturedAt: new Date("2026-09-30") },
    });
  }
  await enrollContacts(db, campaignKey, [contact.id], adminId);
  const member = await db.campaignMember.findFirstOrThrow({ where: { contactId: contact.id, campaign: { key: campaignKey } } });
  if (o.approve !== false) await approveMember(db, member.id, actor);
  return { contact, member, company };
}

async function approveAll() {
  for (const s of await db.outreachSend.findMany({ where: { status: "AWAITING_APPROVAL" } })) await approveOutreachSend(db, s.id, actor);
}

/** Prepare drafts, a human approves them, the batch sends (dry run). */
async function cycle(transport: MailTransport) {
  await runOutreachBatch(db, { llm, transport });
  await approveAll();
  return runOutreachBatch(db, { llm, transport });
}

async function moveToNextDue(memberId: string) {
  const last = await db.outreachSend.findFirstOrThrow({ where: { memberId, status: { in: ["DRY_RUN", "PROVIDER_ACCEPTED"] } }, orderBy: { step: "desc" } });
  const due = followUpDue(last.confirmedAt!, 3, await getOutreachSettings(db))!;
  setClock(() => new Date(due.getTime() + 5 * 60_000));
  return due;
}

const reply = (kind: Parameters<typeof buildSimulatedRaw>[0], send: { providerMessageId: string | null; subject: string | null }, to: string, from: string) =>
  buildSimulatedRaw(kind, { messageId: send.providerMessageId!, fromAddress: from, toAddress: to, subject: send.subject ?? "" });

describe("launch safety", () => {
  it("defaults to Launch Stop and dry run; the sequence provider starts disabled", async () => {
    const { mode, blockers } = await resolveMode(db);
    expect(mode).toBe("dry_run");
    expect(blockers).toEqual(expect.arrayContaining(["Launch Command is Stop", "OUTREACH_LIVE_SEND is not true in the environment", "provider email_sequences is disabled"]));
    expect(await db.providerConfig.findUniqueOrThrow({ where: { key: "email_sequences" } })).toMatchObject({ enabled: false, mode: "AUTOMATED" });
  });

  it("only an admin typing the confirmation can set Start, and Start alone still means dry run", async () => {
    const manager = await makeUser("MANAGER", "m@test.local");
    await expect(setLaunch(db, "START", { id: manager.id, role: "MANAGER" }, LAUNCH_CONFIRMATION)).rejects.toThrow(/Only an admin/);
    await expect(setLaunch(db, "START", actor)).rejects.toThrow(/confirm/);
    await setLaunch(db, "START", actor, LAUNCH_CONFIRMATION);
    expect((await resolveMode(db)).mode).toBe("dry_run");
    await setLaunch(db, "STOP", actor);
    expect(await db.auditLog.count({ where: { action: "outreach.launch" } })).toBe(2);
  });

  it("a dry run can never use a real SMTP transport", async () => {
    await lead("SA-CON");
    await runOutreachBatch(db, { llm });
    await approveAll();
    const account = await db.emailAccount.create({ data: { label: "x", fromName: "x", fromAddress: "x@klyron.example", username: "x", smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false, imapHost: "127.0.0.1", imapPort: 1, imapSecure: false } });
    const smtp = new SmtpTransport(account, "pw");
    const r = await runOutreachBatch(db, { llm, transport: smtp });
    expect(r.outcomes[0]).toMatchObject({ result: "FAILED" });
    expect(r.outcomes[0].codes[0]).toMatch(/never use a real SMTP transport/);
  });
});

describe("dry-run sequence", () => {
  it("runs S01–S05 for SA-CON and SA-PM leads: distinct evidence-led angles, one meeting CTA each, threaded, nothing sent", async () => {
    await approveWaits(3);
    const con = await lead("SA-CON");
    const pm = await lead("SA-PM", { project: null, industry: "Project management consultancy" });
    const t = new DryRunTransport();

    const first = await cycle(t);
    expect(first.mode).toBe("dry_run");
    expect(first.outcomes.map((o) => o.result).sort()).toEqual(["DRY_RUN_SENT", "DRY_RUN_SENT"]);
    for (const m of [con.member, pm.member]) {
      for (let step = 2; step <= 5; step++) {
        await moveToNextDue(m.id);
        await cycle(t);
      }
    }
    // Once every step is done, more ticks add nothing.
    const done = await runOutreachBatch(db, { llm, transport: t });
    expect(done.outcomes.every((o) => o.result === "COMPLETED")).toBe(true);

    expect(t.sent).toHaveLength(10);
    expect(await db.emailMessage.count()).toBe(0); // dry run: no mailbox records
    for (const m of [con, pm]) {
      const rows = await db.outreachSend.findMany({ where: { memberId: m.member.id }, orderBy: { step: "asc" } });
      expect(rows.map((r) => [r.step, r.status, r.dryRun])).toEqual([1, 2, 3, 4, 5].map((s) => [s, "DRY_RUN", true]));
      const exposures = rows.map((r) => (r.generation as { output: { chosenCommercialExposure: string } }).output.chosenCommercialExposure);
      expect(new Set(exposures).size).toBe(5);
      const mails = t.sent.filter((x) => x.to === m.contact.email);
      for (const [i, mail] of mails.entries()) {
        expect(mail.text.match(/15 minutes/g)).toHaveLength(1);
        expect(mail.text).toContain("Mário Quissico\nKlyron Consulting");
        expect(mail.text).toMatch(/unsubscribe/);
        expect(mail.subject).not.toMatch(/^re:/i);
        expect(mail.fromName).toBe("Mário Quissico");
        if (i > 0) expect(mail.inReplyTo).toBe(mails[i - 1].messageId); // in-thread, no forged "Re:"
      }
      // The live sequence position is untouched by a dry run.
      expect(await db.campaignMember.findUniqueOrThrow({ where: { id: m.member.id } })).toMatchObject({ lastStep: 0, lastConfirmedSendAt: null, state: "ACTIVE" });
    }
    const conS1 = (await db.outreachSend.findFirstOrThrow({ where: { memberId: con.member.id, step: 1 } })).generation as { output: { chosenCommercialExposure: string } };
    const pmS1 = (await db.outreachSend.findFirstOrThrow({ where: { memberId: pm.member.id, step: 1 } })).generation as { output: { chosenCommercialExposure: string } };
    expect(conS1.output.chosenCommercialExposure).not.toBe(pmS1.output.chosenCommercialExposure);

    // Steps follow the previous confirmed send + approved wait, only inside Maputo batches.
    const rows = await db.outreachSend.findMany({ where: { memberId: con.member.id }, orderBy: { step: "asc" } });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].confirmedAt!.getTime() - rows[i - 1].confirmedAt!.getTime()).toBeGreaterThanOrEqual(3 * 86_400_000);
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Maputo", weekday: "short", hour: "2-digit", hourCycle: "h23" }).format(rows[i].confirmedAt!);
      expect(local).toMatch(/^(Mon|Tue|Wed|Thu|Fri),? (09|1[0-5])$/);
    }
  });

  it("S01 may carry the approved booking link; other domains are refused when editing", async () => {
    await saveOutreachSettings(db, { bookingUrl: "https://klyronconsulting.com/en/book", hourlyCap: "20", dailyCap: "140" }, adminId);
    await lead("SA-CON");
    await runOutreachBatch(db, { llm });
    const s1 = await db.outreachSend.findFirstOrThrow({ where: { step: 1 } });
    expect(s1.status).toBe("AWAITING_APPROVAL");
    expect(s1.body).toContain("https://klyronconsulting.com/en/book");
    await expect(approveOutreachSend(db, s1.id, actor, { body: s1.body!.replace("https://klyronconsulting.com/en/book", "https://bit.ly/x1") })).rejects.toThrow(/LINK_SHORTENER/);
    await expect(approveOutreachSend(db, s1.id, actor, { subject: `Re: ${s1.subject}` })).rejects.toThrow(/MISLEADING_SUBJECT/);
    await approveOutreachSend(db, s1.id, actor);
    const t = new DryRunTransport();
    await runOutreachBatch(db, { llm, transport: t });
    expect(t.sent[0].text).toContain("https://klyronconsulting.com/en/book");
  });

  it("holds a follow-up whose wait days nobody approved (never invents an interval)", async () => {
    const { member } = await lead("SA-CON");
    await cycle(new DryRunTransport());
    setClock(() => new Date("2026-11-04T08:05:00Z"));
    const r = await runOutreachBatch(db, { llm });
    expect(r.outcomes.find((o) => o.memberId === member.id)).toMatchObject({ step: 2, result: "HELD", codes: ["STEP_WAIT_DAYS_UNAPPROVED"] });
    expect(await db.outreachSend.count({ where: { step: 2 } })).toBe(0);
  });
});

describe("gates fail closed with reason codes", () => {
  it("holds or routes to research before anything is drafted", async () => {
    const noNeed = await lead("SA-CON", { needs: [] });
    const noConsent = await lead("SA-CON", { consent: "none" });
    const onlyRequested = await lead("SA-CON", { consent: "requested" });
    const unverified = await lead("SA-CON", { verified: false });
    const wrongRole = await lead("SA-CON", { title: "Receptionist" });
    const notZa = await lead("SA-CON", { country: "GB" });
    const pending = await lead("SA-PM", { approve: false });
    const r = await runOutreachBatch(db, { llm });
    const by = (id: string) => r.outcomes.find((o) => o.memberId === id)!;

    expect(by(noNeed.member.id)).toMatchObject({ result: "RESEARCH_REQUIRED", codes: ["NEED_EVIDENCE_MISSING"] });
    expect(by(noConsent.member.id).codes).toContain("PERMISSION_MISSING");
    expect(by(onlyRequested.member.id).codes).toContain("PERMISSION_MISSING"); // a consent request is not a sales sequence
    expect(by(unverified.member.id).codes).toEqual(["EMAIL_NOT_VERIFIED"]);
    expect(by(wrongRole.member.id).codes).toEqual(["ICP_ROLE_UNCONFIRMED"]);
    expect(by(notZa.member.id).codes).toEqual(expect.arrayContaining(["WRONG_COUNTRY"]));
    expect(by(pending.member.id)).toMatchObject({ result: "SKIPPED" });
    expect(await db.outreachSend.count()).toBe(0);
    expect(await db.campaignMember.findUniqueOrThrow({ where: { id: noNeed.member.id } })).toMatchObject({ state: "RESEARCH_REQUIRED", holdReason: "NEED_EVIDENCE_MISSING" });
    expect(await db.campaignMember.findUniqueOrThrow({ where: { id: noConsent.member.id } })).toMatchObject({ state: "HOLD" });
  });

  it("clears duplicates across campaigns and respects suppression and the emergency stop", async () => {
    const a = await lead("SA-CON");
    await enrollContacts(db, "SA-PM", [a.contact.id], adminId);
    const dup = await db.campaignMember.findFirstOrThrow({ where: { contactId: a.contact.id, campaign: { key: "SA-PM" } } });
    await approveMember(db, dup.id, actor);
    const sup = await lead("SA-CON");
    await db.suppression.create({ data: { email: sup.contact.email!, reason: "opt_out", source: "historical list", channel: null } });

    const r = await runOutreachBatch(db, { llm });
    expect(r.outcomes.find((o) => o.memberId === dup.id)!.codes).toEqual(["DUPLICATE"]);
    expect(r.outcomes.find((o) => o.memberId === sup.member.id)).toMatchObject({ result: "STOPPED", codes: ["OPT_OUT"] });
    expect(r.outcomes.find((o) => o.memberId === a.member.id)!.result).toBe("GENERATED");

    await approveAll();
    await setEmergencyStop(db, true, actor, "test");
    const t = new DryRunTransport();
    const r2 = await runOutreachBatch(db, { llm, transport: t });
    expect(r2.outcomes.find((o) => o.memberId === a.member.id)).toMatchObject({ result: "DEFERRED" });
    expect(r2.outcomes.find((o) => o.memberId === a.member.id)!.codes).toContain("EMERGENCY_STOP");
    expect(t.sent).toHaveLength(0);
  });
});

describe("reply & stop watch", () => {
  async function afterFirstSend(campaign: "SA-CON" | "SA-PM" = "SA-CON") {
    await approveWaits(3);
    const l = await lead(campaign);
    await cycle(new DryRunTransport());
    const s1 = await db.outreachSend.findFirstOrThrow({ where: { memberId: l.member.id, step: 1 } });
    const account = await seedSimulatedMailbox(db, true);
    return { ...l, s1, account };
  }
  const state = (id: string) => db.campaignMember.findUniqueOrThrow({ where: { id } });

  it("a genuine reply stops all follow-ups", async () => {
    const { member, contact, s1, account } = await afterFirstSend();
    await ingestRawEmail(db, account.id, reply("interested", s1, contact.email!, account.fromAddress), { llm });
    expect(await state(member.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLY" });
    await moveToNextDue(member.id);
    const t = new DryRunTransport();
    await cycle(t);
    expect(t.sent).toHaveLength(0);
    expect(await db.outreachSend.count({ where: { memberId: member.id } })).toBe(1);
  });

  it("an opt-out suppresses and stops immediately", async () => {
    const { member, contact, s1, account } = await afterFirstSend();
    await ingestRawEmail(db, account.id, reply("unsubscribe", s1, contact.email!, account.fromAddress), { llm });
    expect(await state(member.id)).toMatchObject({ state: "STOPPED", stopReason: "OPT_OUT" });
    expect(await db.suppression.count({ where: { email: contact.email! } })).toBe(1);
  });

  it("a hard bounce suppresses the address and stops", async () => {
    const { member, contact, s1, account } = await afterFirstSend();
    await ingestRawEmail(db, account.id, reply("bounce", s1, contact.email!, account.fromAddress), { llm });
    expect(await state(member.id)).toMatchObject({ state: "STOPPED", stopReason: "HARD_BOUNCE" });
    expect(await db.suppression.findFirst({ where: { email: contact.email! } })).toMatchObject({ reason: "bounce" });
  });

  it("a soft bounce holds for review without suppressing", async () => {
    const { member, contact, s1, account } = await afterFirstSend();
    const raw = reply("bounce", s1, contact.email!, account.fromAddress).toString().replace("Status: 5.1.1", "Status: 4.2.2").replace(/Diagnostic-Code:.*\r\n/, "");
    await ingestRawEmail(db, account.id, Buffer.from(raw), { llm });
    expect(await state(member.id)).toMatchObject({ state: "HOLD", holdReason: "SOFT_BOUNCE" });
    expect(await db.suppression.count()).toBe(0);
  });

  it("an out-of-office reply is logged and does not stop the sequence", async () => {
    const { member, contact, s1, account } = await afterFirstSend();
    await ingestRawEmail(db, account.id, reply("out_of_office", s1, contact.email!, account.fromAddress), { llm });
    expect(await state(member.id)).toMatchObject({ state: "ACTIVE", stopReason: null });
    expect(await db.auditLog.count({ where: { action: "outreach.auto_reply" } })).toBe(1);
    await moveToNextDue(member.id);
    const t = new DryRunTransport();
    await cycle(t);
    expect(t.sent).toHaveLength(1);
  });

  it("an unclassifiable reply holds rather than guessing", async () => {
    const { member, contact, s1, account } = await afterFirstSend();
    const raw = reply("interested", s1, contact.email!, account.fromAddress).toString().replace(/Hi, thanks for reaching out\. Sounds good, let's chat next Tuesday morning\./, "Forwarding this to the relevant team.");
    await ingestRawEmail(db, account.id, Buffer.from(raw), { llm });
    expect(await state(member.id)).toMatchObject({ state: "HOLD", holdReason: "REPLY_UNCERTAIN" });
  });

  it("a confirmed booking stops; a tentative one holds; a simulated rehearsal is ignored", async () => {
    const a = await afterFirstSend();
    const b = await lead("SA-CON");
    const c = await lead("SA-PM");
    const at = { startsAt: new Date("2026-10-28T08:00:00Z"), endsAt: new Date("2026-10-28T08:15:00Z"), title: "Klyron 15 min" };
    await db.meeting.create({ data: { contactId: a.contact.id, status: "scheduled", ...at } });
    await db.meeting.create({ data: { contactId: b.contact.id, status: "tentative", ...at } });
    await db.meeting.create({ data: { contactId: c.contact.id, status: "simulated", ...at } });
    const w = await runStopWatch(db);
    expect(w).toMatchObject({ stopped: 1, held: 1 });
    expect(await state(a.member.id)).toMatchObject({ state: "STOPPED", stopReason: "BOOKED" });
    expect(await state(b.member.id)).toMatchObject({ state: "HOLD", holdReason: "BOOKING_TENTATIVE" });
    expect(await state(c.member.id)).toMatchObject({ state: "ACTIVE" });
  });
});

describe("idempotency, retries, timing and caps", () => {
  it("repeated and concurrent scheduler ticks never duplicate a send", async () => {
    await lead("SA-CON");
    await lead("SA-PM");
    const t = new DryRunTransport();
    await runOutreachBatch(db, { llm, transport: t });
    await Promise.all([runOutreachBatch(db, { llm, transport: t }), runOutreachBatch(db, { llm, transport: t })]); // no duplicate drafts
    expect(await db.outreachSend.count()).toBe(2);
    await approveAll();
    await Promise.all([runOutreachBatch(db, { llm, transport: t }), runOutreachBatch(db, { llm, transport: t }), runOutreachBatch(db, { llm, transport: t })]);
    await runOutreachBatch(db, { llm, transport: t });
    expect(t.sent).toHaveLength(2);
    expect(await db.outreachSend.count({ where: { status: "DRY_RUN" } })).toBe(2);
  });

  it("retries a connection failure once it clears; an unknown outcome is never resent and blocks the next step", async () => {
    await approveWaits(3);
    const a = await lead("SA-CON");
    const b = await lead("SA-PM");
    await runOutreachBatch(db, { llm });
    await approveAll();
    const sent: OutboundEmail[] = [];
    let calls = 0;
    const flaky: MailTransport = {
      verify: async () => {},
      send: async (m) => {
        calls++;
        if (m.to === a.contact.email && calls <= 2) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" });
        if (m.to === b.contact.email) throw new Error("socket closed after DATA");
        sent.push(m);
        return { accepted: [m.to], rejected: [], response: "250 ok" };
      },
    };
    await runOutreachBatch(db, { llm, transport: flaky });
    const aRow = await db.outreachSend.findFirstOrThrow({ where: { memberId: a.member.id } });
    const bRow = await db.outreachSend.findFirstOrThrow({ where: { memberId: b.member.id } });
    expect(aRow).toMatchObject({ status: "APPROVED", attempts: 1 });
    expect(bRow).toMatchObject({ status: "UNKNOWN", attempts: 1 });

    await runOutreachBatch(db, { llm, transport: flaky });
    expect(await db.outreachSend.findUniqueOrThrow({ where: { id: aRow.id } })).toMatchObject({ status: "DRY_RUN", attempts: 2 });
    const afterB = await db.outreachSend.findUniqueOrThrow({ where: { id: bRow.id } });
    expect(afterB).toMatchObject({ status: "UNKNOWN", attempts: 1 }); // never retried
    expect(sent.filter((m) => m.to === a.contact.email)).toHaveLength(1);

    await moveToNextDue(a.member.id);
    const r = await runOutreachBatch(db, { llm, transport: flaky });
    expect(r.outcomes.find((o) => o.memberId === b.member.id)).toMatchObject({ result: "HELD", codes: ["UNCONFIRMED_PRIOR_SEND"] });

    await reconcileUnknownSend(db, bRow.id, "accepted", "found in Hostinger Sent folder", actor);
    expect(await db.outreachSend.findUniqueOrThrow({ where: { id: bRow.id } })).toMatchObject({ status: "PROVIDER_ACCEPTED" });
  });

  it("sends only inside Maputo weekday batches, but still prepares drafts", async () => {
    await lead("SA-CON");
    setClock(() => new Date("2026-10-24T08:05:00Z")); // Saturday 10:05
    const t = new DryRunTransport();
    await runOutreachBatch(db, { llm, transport: t });
    await approveAll();
    const sat = await runOutreachBatch(db, { llm, transport: t });
    expect(sat.slot).toBeNull();
    expect(sat.outcomes[0]).toMatchObject({ result: "DEFERRED", codes: ["OUTSIDE_BATCH_WINDOW"] });
    setClock(() => new Date("2026-10-26T06:30:00Z")); // Monday 08:30
    expect((await runOutreachBatch(db, { llm, transport: t })).outcomes[0].codes).toEqual(["OUTSIDE_BATCH_WINDOW"]);
    setClock(() => new Date("2026-10-26T07:02:00Z")); // Monday 09:02
    const mon = await runOutreachBatch(db, { llm, transport: t });
    expect(mon.slot).toBe("2026-10-26T07:00:00.000Z");
    expect(t.sent).toHaveLength(1);
  });

  it("enforces the combined hourly and daily caps across both campaigns", async () => {
    await saveOutreachSettings(db, { hourlyCap: "2", dailyCap: "3" }, adminId);
    for (let i = 0; i < 2; i++) await lead("SA-CON");
    for (let i = 0; i < 2; i++) await lead("SA-PM");
    const t = new DryRunTransport();
    await runOutreachBatch(db, { llm, transport: t });
    await approveAll();
    const r1 = await runOutreachBatch(db, { llm, transport: t });
    expect(r1.outcomes.filter((o) => o.result === "DRY_RUN_SENT")).toHaveLength(2);
    expect(r1.outcomes.filter((o) => o.codes.includes("CAP_HOURLY"))).toHaveLength(2);

    setClock(() => new Date("2026-10-21T09:05:00Z")); // 11:05
    const r2 = await runOutreachBatch(db, { llm, transport: t });
    expect(r2.outcomes.filter((o) => o.result === "DRY_RUN_SENT")).toHaveLength(1);
    expect(r2.outcomes.filter((o) => o.codes.includes("CAP_DAILY"))).toHaveLength(1);

    setClock(() => new Date("2026-10-22T07:05:00Z")); // Thursday 09:05
    await runOutreachBatch(db, { llm, transport: t });
    expect(t.sent).toHaveLength(4);
  });
});

describe("live path (mocked transport; proves the gate, sends nothing)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is reachable only with every condition, records SMTP acceptance as ACCEPTED, and reconciles provider-confirmed counts", async () => {
    await approveWaits(3);
    const { member } = await lead("SA-CON");
    await runOutreachBatch(db, { llm });
    await approveAll();
    // Rehearsal rows never leak into a live run.
    await runOutreachBatch(db, { llm, transport: new DryRunTransport() });
    expect((await outreachReconciliation(db)).rows.find((r) => r.campaign === "SA-CON")).toMatchObject({ sent: 0, dryRunSends: 1 });

    const account = await db.emailAccount.create({
      data: { label: "Klyron", fromName: "Mário Quissico", fromAddress: "contact@klyron.example", username: "contact@klyron.example", smtpHost: "smtp.invalid", smtpPort: 465, smtpSecure: true, imapHost: "imap.invalid", imapPort: 993, imapSecure: true, enabled: true, lastTestResult: "ok" },
    });
    await saveOutreachSettings(db, { emailAccountId: account.id, hourlyCap: "20", dailyCap: "140" }, adminId);
    await setLaunch(db, "START", actor, LAUNCH_CONFIRMATION);
    process.env.OUTREACH_LIVE_SEND = "true";
    process.env.SIMULATION_MODE = "false";
    process.env.ALLOW_AUTOMATED_OUTREACH = "true";
    expect((await resolveMode(db)).blockers).toEqual(["provider email_sequences is disabled", "no recorded carrier/provider authorisation"]);
    await db.providerConfig.update({ where: { key: "email_sequences" }, data: { enabled: true, carrierAuthorized: true, carrierAuthRef: "legal sign-off TEST" } });
    expect(await resolveMode(db)).toEqual({ mode: "live", blockers: [] });

    const sent: OutboundEmail[] = [];
    const mock: MailTransport = { verify: async () => {}, send: async (m) => (sent.push(m), { accepted: [m.to], rejected: [], response: "250 2.0.0 queued" }) };
    await runOutreachBatch(db, { llm, transport: mock }); // live drafts need their own human approval
    expect(sent).toHaveLength(0);
    await approveAll();
    const r = await runOutreachBatch(db, { llm, transport: mock });
    expect(r.mode).toBe("live");
    expect(sent).toHaveLength(1);
    const row = await db.outreachSend.findFirstOrThrow({ where: { dryRun: false } });
    expect(row).toMatchObject({ status: "PROVIDER_ACCEPTED", idempotencyKey: expect.stringMatching(/:SA-CON:S01$/) });
    expect(await db.emailMessage.findUniqueOrThrow({ where: { messageId: row.providerMessageId! } })).toMatchObject({ deliveryState: "ACCEPTED", deliveryEvidence: "smtp_250" });
    expect(await db.campaignMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ lastStep: 1, state: "ACTIVE" });
    expect((await outreachReconciliation(db)).rows.find((x) => x.campaign === "SA-CON")).toMatchObject({ sent: 1, dryRunSends: 1 });

    // Launch back to Stop: the very next attempt is refused at send time.
    await moveToNextDue(member.id);
    await runOutreachBatch(db, { llm, transport: mock });
    await approveAll();
    await setLaunch(db, "STOP", actor);
    const s2 = await db.outreachSend.findFirstOrThrow({ where: { dryRun: false, step: 2 } });
    const res = await sendOutreach(db, s2.id, { mode: "live", slot: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000), now: new Date(), settings: await getOutreachSettings(db), transport: mock, steps: [], actorId: null });
    expect(res.codes).toContain("LIVE_BLOCKED");
    expect(sent).toHaveLength(1);
  });
});
