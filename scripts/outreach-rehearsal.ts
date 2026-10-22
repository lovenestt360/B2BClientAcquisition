/**
 * Dry-run rehearsal of the SA email sequences on SYNTHETIC leads, in a throwaway database.
 *
 *   REHEARSAL_DATABASE_URL=postgresql://app:app@localhost:5432/acquisition_rehearsal npm run outreach:rehearsal
 *
 * Runs S01–S05 for synthetic SA-CON and SA-PM leads plus the gate/stop scenarios, through the
 * real pipeline (generation, validation, gates, Maputo batches, caps, idempotency, reply watch)
 * with the no-network dry-run transport, and writes a Markdown report. It refuses any database
 * whose name does not end in "_rehearsal" because it wipes it first.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const url = process.env.REHEARSAL_DATABASE_URL ?? "postgresql://app:app@localhost:5432/acquisition_rehearsal";
const dbName = new URL(url).pathname.replace(/^\//, "");
if (!dbName.endsWith("_rehearsal")) {
  console.error(`Refusing to run: database "${dbName}" must end in _rehearsal (it is wiped first).`);
  process.exit(1);
}
const out = process.argv[2] ?? "docs/OUTREACH_DRY_RUN.md";

// Fail-safe environment: everything that could enable live sending is forced off.
Object.assign(process.env, { DATABASE_URL: url, OUTREACH_LIVE_SEND: "false", ALLOW_AUTOMATED_OUTREACH: "false", SIMULATION_MODE: "true", LLM_PROVIDER: "mock" });

async function main() {
  try {
    execSync(`psql "${url.replace(/\/[^/]+$/, "/postgres")}" -tc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || psql "${url.replace(/\/[^/]+$/, "/postgres")}" -c "CREATE DATABASE ${dbName}"`, { stdio: "ignore" });
  } catch {
    /* database may already exist or psql may be absent; migrate will tell */
  }
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });

  const db = new PrismaClient({ datasources: { db: { url } } });
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);

  const { setClock } = await import("../src/server/clock");
  const { hashPassword } = await import("../src/server/auth/password");
  const { seedProviderRows } = await import("../src/server/providers/registry");
  const { setSenderProfile } = await import("../src/server/compliance/controls");
  const cfgMod = await import("../src/server/outreach/config");
  const seq = await import("../src/server/outreach/sequence");
  const { followUpDue } = await import("../src/server/outreach/schedule");
  const { DryRunTransport } = await import("../src/server/email/transport");
  const { MockLlmClient } = await import("../src/server/ai/llm");
  const { seedSimulatedMailbox } = await import("../src/server/email/accounts");
  const { ingestRawEmail } = await import("../src/server/email/ingest");
  const { buildSimulatedRaw } = await import("../src/server/email/simulate");
  const { outreachReconciliation } = await import("../src/server/outreach/report");

  let clock = new Date("2026-10-21T08:05:00Z"); // Wednesday 10:05 Maputo
  setClock(() => clock);
  const admin = await db.user.create({ data: { email: "rehearsal@local", name: "Rehearsal", role: "ADMIN", passwordHash: await hashPassword(crypto.randomUUID()) } });
  const actor = { id: admin.id, role: admin.role };
  await seedProviderRows(db, { simulation: true });
  await setSenderProfile(db, { businessName: "Klyron Consulting", optOutText: "Reply STOP to opt out" }, admin.id);
  await cfgMod.syncOutreachConfig(db, cfgMod.loadConfigFile(), admin.id);
  await db.campaign.updateMany({ where: { key: { not: null } }, data: { status: "ACTIVE" } });
  // Rehearsal-only wait: real values must be approved by you on /outreach.
  const REHEARSAL_WAIT = 3;
  for (const s of await db.outreachStep.findMany({ where: { step: { gt: 1 } } })) await cfgMod.approveStepTiming(db, s.id, REHEARSAL_WAIT, admin.id);

  const llm = new MockLlmClient();
  const t = new DryRunTransport();
  let n = 0;
  async function lead(campaign: string, o: { first: string; last: string; title: string; company: string; industry: string; project?: string; facts?: string[]; needs: string[]; consent?: boolean; verified?: boolean }) {
    n++;
    const company = await db.company.create({ data: { name: o.company, normalizedName: o.company.toLowerCase(), industry: o.industry, country: "ZA", domain: `synthetic${n}.example` } });
    const contact = await db.contact.create({
      data: { firstName: o.first, lastName: o.last, fullNameNormalized: `${o.first} ${o.last}`.toLowerCase(), title: o.title, email: `${o.first.toLowerCase()}@synthetic${n}.example`, emailVerifiedAt: o.verified === false ? null : new Date("2026-10-01"), emailVerificationStatus: o.verified === false ? "Not checked" : "Valid", country: "ZA", companyId: company.id, isSimulated: true, sourceType: "import" },
    });
    const fact = (kind: string, field: string, value: string, i: number) =>
      db.researchFact.create({ data: { companyId: company.id, kind, field, value, sourceUrl: `https://synthetic.example/${n}/${i}`, confidence: 0.85, verifiedAt: new Date("2026-10-01") } });
    let i = 0;
    if (o.project) await fact("project", "project", o.project, i++);
    for (const f of o.facts ?? []) await fact("fact", "about", f, i++);
    for (const f of o.needs) await fact("need_evidence", "need", f, i++);
    if (o.consent !== false) await db.marketingPermission.create({ data: { contactId: contact.id, channel: "EMAIL", status: "GRANTED", basis: "CONSENT", evidence: "SYNTHETIC consent record", capturedAt: new Date("2026-09-30") } });
    await seq.enrollContacts(db, campaign, [contact.id], admin.id);
    const member = await db.campaignMember.findFirstOrThrow({ where: { contactId: contact.id } });
    await seq.approveMember(db, member.id, actor);
    return { contact, member };
  }
  const approveAll = async () => {
    for (const s of await db.outreachSend.findMany({ where: { status: "AWAITING_APPROVAL" } })) await seq.approveOutreachSend(db, s.id, actor);
  };
  const tick = async () => {
    await seq.runOutreachBatch(db, { llm, transport: t });
    await approveAll(); // stands in for your review in the rehearsal only
    return seq.runOutreachBatch(db, { llm, transport: t });
  };

  // ── Sequence leads (synthetic) ──
  const con = await lead("SA-CON", { first: "Thandi", last: "Synthetic", title: "Project Director", company: "Synthetic Build (Pty) Ltd", industry: "Healthcare construction", project: "Synthetic District Hospital extension", needs: ["Tender notes heavy MEP services installation in occupied wards", "Prefabricated steel procurement on a fast-track programme"] });
  const pm = await lead("SA-PM", { first: "Johan", last: "Synthetic", title: "Programme Director", company: "Synthetic PM Partners", industry: "Project management consultancy", facts: ["Programme management for public sector clients"], needs: ["Monthly client reporting on risk across a portfolio of school projects", "Design team coordination issues raised in progress meetings"] });
  const transcript: string[] = [];
  for (const m of [con, pm]) {
    clock = new Date("2026-10-21T08:05:00Z");
    for (let step = 1; step <= 5; step++) {
      if (step > 1) {
        const last = await db.outreachSend.findFirstOrThrow({ where: { memberId: m.member.id, status: "DRY_RUN" }, orderBy: { step: "desc" } });
        clock = new Date(followUpDue(last.confirmedAt!, REHEARSAL_WAIT, await cfgMod.getOutreachSettings(db))!.getTime() + 5 * 60_000);
      }
      await tick();
    }
  }
  for (const m of [con, pm]) {
    const rows = await db.outreachSend.findMany({ where: { memberId: m.member.id }, orderBy: { step: "asc" } });
    const campaign = (await db.campaign.findUniqueOrThrow({ where: { id: m.member.campaignId } })).key;
    transcript.push(`### ${campaign}: ${m.contact.firstName} ${m.contact.lastName}, ${m.contact.title}\n`);
    for (const r of rows) {
      const g = r.generation as { output: { chosenCommercialExposure: string; supportingEvidenceIds: string[] } };
      const v = r.validation as { decision: string; wordCount: number; warnings: string[] };
      const mail = t.sent.find((x) => x.messageId === r.providerMessageId)!;
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Maputo", dateStyle: "medium", timeStyle: "short" }).format(r.confirmedAt!);
      transcript.push(
        `**${seq.stepLabel(r.step)}** · ${r.status} at ${local} Maputo · angle \`${g.output.chosenCommercialExposure}\` · ${v.wordCount} words · validator ${v.decision}${v.warnings.length ? ` (${v.warnings.join("; ")})` : ""} · evidence ${g.output.supportingEvidenceIds.length} · ${mail.inReplyTo ? "threaded" : "new thread"}\n`,
        "```text",
        `Subject: ${mail.subject}`,
        "",
        mail.text,
        "```\n",
      );
    }
  }

  // ── Gate and stop scenarios (synthetic) ──
  clock = new Date("2026-11-11T08:05:00Z");
  const scenario: [string, string][] = [];
  const base = { title: "Construction Manager", company: "Synthetic Gate Co", industry: "Commercial construction", project: "Synthetic Office Park", needs: ["MEP installation on a fast-track programme"] };
  const noNeed = await lead("SA-CON", { ...base, first: "Nonee", last: "Synthetic", company: "Synthetic Gate A", needs: [] });
  const noConsent = await lead("SA-CON", { ...base, first: "Noconsent", last: "Synthetic", company: "Synthetic Gate B", consent: false });
  const unverified = await lead("SA-CON", { ...base, first: "Unverified", last: "Synthetic", company: "Synthetic Gate C", verified: false });
  const replier = await lead("SA-PM", { ...base, title: "Project Manager", first: "Replier", last: "Synthetic", company: "Synthetic Gate D", needs: ["Client reporting on risk"] });
  const bounce = await lead("SA-PM", { ...base, title: "Partner", first: "Bouncer", last: "Synthetic", company: "Synthetic Gate E", needs: ["Design team coordination issues"] });
  const booked = await lead("SA-CON", { ...base, first: "Booker", last: "Synthetic", company: "Synthetic Gate F" });
  await tick();
  await tick(); // a repeated tick must not duplicate anything
  const account = await seedSimulatedMailbox(db, true);
  const s1 = (id: string) => db.outreachSend.findFirstOrThrow({ where: { memberId: id, step: 1 } });
  for (const [who, kind] of [[replier, "interested"], [bounce, "bounce"]] as const) {
    const s = await s1(who.member.id);
    await ingestRawEmail(db, account.id, buildSimulatedRaw(kind, { messageId: s.providerMessageId!, fromAddress: account.fromAddress, toAddress: who.contact.email!, subject: s.subject ?? "" }), { llm });
  }
  await db.meeting.create({ data: { contactId: booked.contact.id, title: "15 min", startsAt: new Date("2026-11-12T08:00:00Z"), endsAt: new Date("2026-11-12T08:15:00Z"), status: "scheduled" } });
  clock = new Date("2026-11-16T08:05:00Z");
  await tick();
  for (const [label, who] of [["No need evidence", noNeed], ["No documented consent", noConsent], ["Email not verified", unverified], ["Replied after S01", replier], ["Hard bounce after S01", bounce], ["Meeting booked after S01", booked]] as const) {
    const m = await db.campaignMember.findUniqueOrThrow({ where: { id: who.member.id } });
    const sends = await db.outreachSend.count({ where: { memberId: m.id, status: "DRY_RUN" } });
    scenario.push([label, `${m.state}${m.stopReason ? ` (${m.stopReason})` : m.holdReason ? ` (${m.holdReason})` : ""}; dry-run sends: ${sends}`]);
  }

  const rec = await outreachReconciliation(db);
  const mode = await cfgMod.resolveMode(db);
  const lines = [
    "# Email sequences: dry-run rehearsal",
    "",
    `Generated by \`npm run outreach:rehearsal\` on synthetic leads in an isolated \`${dbName}\` database. **No email was sent**: every message went to the dry-run transport, which never opens a network connection.`,
    "",
    `- Mode: **${mode.mode}**; blockers: ${mode.blockers.join("; ")}`,
    `- Generator: offline evidence composer (\`LLM_PROVIDER=mock\`). With Ollama the model writes, and the same validator and gates apply.`,
    `- Wait days: ${REHEARSAL_WAIT} days, set for this rehearsal only. Real values are unapproved until you approve them on /outreach.`,
    `- Human approval: approved by the rehearsal script, standing in for your review.`,
    `- Dry-run sends recorded: ${t.sent.length}; mailbox records created: ${await db.emailMessage.count({ where: { direction: "outbound" } })}`,
    "",
    "## Gate and stop scenarios",
    "",
    "| Scenario | Result |",
    "|---|---|",
    ...scenario.map(([a, b]) => `| ${a} | ${b} |`),
    "",
    "## Reconciliation (provider-confirmed sends only; dry runs counted separately)",
    "",
    "| Campaign | Enrolled | Approved | Sent | Dry-run sends | Replied | Booked | Hard bounce | Suppressed |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rec.rows.map((r) => `| ${r.campaign} | ${r.enrolled} | ${r.approved} | ${r.sent} | ${r.dryRunSends} | ${r.replied} | ${r.booked} | ${r.hardBounced} | ${r.suppressed} |`),
    "",
    `Holds by reason: ${Object.entries(rec.holds).map(([k, v]) => `${k} × ${v}`).join(", ") || "none"}`,
    "",
    "## Five-step sequences (synthetic leads)",
    "",
    ...transcript,
  ];
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`Rehearsal complete: ${t.sent.length} dry-run sends, report written to ${out}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
